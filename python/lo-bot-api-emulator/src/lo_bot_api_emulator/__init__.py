"""Request validation fixtures. Storage, authorization and transcoding require live LO."""

import argparse
import json
from importlib.resources import files

from aiohttp import web

CONTRACT = json.loads(files(__package__).joinpath("contract.json").read_text())


class ApiRefusal(Exception):
    def __init__(self, description, status=400, parameters=None):
        self.description, self.status, self.parameters = description, status, parameters


class LoBotApiEmulator:
    def __init__(self, *, video_uploads=True, single_attach=True, video_retry_count=0):
        self.video_uploads = video_uploads
        self.single_attach = single_attach
        self.video_retry_count = video_retry_count
        self.requests = []
        self.assets = {}
        self.next_id = 1

    def app(self):
        app = web.Application(client_max_size=512 * 1024 * 1024)
        app.router.add_post("/bot{token}/{method}", self.handle)
        app.router.add_get("/file/bot{token}/{path:.*}", self.download)
        return app

    async def download(self, request):
        asset = self.assets.get(request.match_info["path"])
        if asset is None:
            raise web.HTTPNotFound()
        return web.Response(body=asset.get("data", b"fixture"))

    async def read_request(self, request):
        fields, uploads = {}, {}
        if request.content_type == "application/json":
            fields = await request.json()
            if not isinstance(fields, dict):
                raise ApiRefusal("Bad Request: expected an object")
        elif request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            async for part in reader:
                if not part.name or part.name in fields or part.name in uploads:
                    raise ApiRefusal("Bad Request: duplicate parameter")
                if part.filename is None:
                    fields[part.name] = await part.text()
                else:
                    size, data = 0, bytearray()
                    while chunk := await part.read_chunk():
                        size += len(chunk)
                        if size > CONTRACT["limits"]["fileBytes"]:
                            raise ApiRefusal("Bad Request: file is too big")
                        data.extend(chunk)
                    uploads[part.name] = {
                        "filename": part.filename,
                        "data": bytes(data),
                        "size": size,
                    }
        else:
            fields = dict(await request.post())
        return fields, uploads

    @staticmethod
    def decoded(value):
        return json.loads(value) if isinstance(value, str) else value

    def source(self, kind, value, uploads, *, album=False):
        if kind in uploads:
            return uploads[kind]
        if isinstance(value, str) and value.startswith("attach://"):
            if not album and not self.single_attach:
                raise ApiRefusal("Bad Request: " + value[9:] + " is not supported yet")
            upload = uploads.get(value[9:])
            if upload is None:
                raise ApiRefusal("Bad Request: wrong file identifier/HTTP URL specified")
            return upload
        if isinstance(value, str) and value in self.assets:
            return value
        raise ApiRefusal("Bad Request: wrong file identifier/HTTP URL specified")

    def media_message(self, chat, kind, source, caption=None, message_id=None):
        if isinstance(source, dict):
            if source["size"] > CONTRACT["limits"]["photoBytes"] and kind == "photo":
                raise ApiRefusal("Bad Request: file is too big")
            reference = f"fixture-{kind}-{self.next_id}"
            self.assets[reference] = source
        else:
            reference = source
        result = {
            "message_id": message_id or self.next_id,
            "date": 1,
            "chat": {"id": int(chat), "type": "private" if int(chat) > 0 else "group"},
        }
        self.next_id += 1
        asset: dict[str, object] = {"file_id": reference, "file_unique_id": reference + "-unique"}
        if kind == "photo":
            asset.update(width=1, height=1)
            result[kind] = [asset]
        elif kind == "video":
            asset.update(width=1, height=1, duration=1)
            result[kind] = asset
        elif kind in ("voice", "audio"):
            asset["duration"] = 1
            result[kind] = asset
        else:
            result[kind] = asset
        if caption is not None:
            result["caption"] = caption
        return result

    def validate(self, method, fields, uploads):
        definition = CONTRACT["methods"].get(method)
        if definition is None:
            raise ApiRefusal("Not Found: method not found", 404)
        if not definition["implemented"]:
            raise ApiRefusal(
                "Method not implemented: " + method, 501, {"reason": "method_not_implemented"}
            )
        if definition["parameters"] is None:
            # Do not claim a server method passed when this fixture does not model it.
            raise ApiRefusal("Emulator does not model this method: " + method, 501)
        if "method" in uploads or "method" in fields and fields["method"] != method:
            raise ApiRefusal(
                "Bad Request: method must match the request path",
                parameters={"reason": "unsupported_parameter", "parameter": "method"},
            )
        fields.pop("method", None)
        allowed = set(definition["parameters"])
        for key in ("photo", "document", "voice", "audio", "video", "thumbnail"):
            value = fields.get(key)
            if (
                key in allowed
                and isinstance(value, str)
                and value.startswith("attach://")
                and self.single_attach
            ):
                allowed.add(value[9:])
        media = None
        if method == "sendMediaGroup":
            try:
                media = self.decoded(fields.get("media"))
            except (ValueError, TypeError):
                raise ApiRefusal("Bad Request: media must be a JSON array") from None
            if (
                not isinstance(media, list)
                or not CONTRACT["inputMedia"]["minItems"]
                <= len(media)
                <= CONTRACT["inputMedia"]["maxItems"]
            ):
                raise ApiRefusal("Bad Request: media must include 2 to 10 items")
            for index, item in enumerate(media):
                if not isinstance(item, dict):
                    raise ApiRefusal("Bad Request: invalid media item")
                for key in sorted(item):
                    if key not in CONTRACT["inputMedia"]["parameters"]:
                        raise ApiRefusal(
                            "Bad Request: media item "
                            + str(index)
                            + ": "
                            + key
                            + " is not supported yet"
                        )
                value = item.get("media")
                if isinstance(value, str) and value.startswith("attach://"):
                    allowed.add(value[9:])
            types = {item.get("type") for item in media}
            for item in media:
                if item.get("type") not in CONTRACT["inputMedia"]["types"]:
                    raise ApiRefusal(
                        "Bad Request: media type " + str(item.get("type")) + " is not supported yet"
                    )
            if len(types) != 1:
                raise ApiRefusal("Bad Request: a media group must contain items of one type")
            if any(item.get("caption") for item in media[1:]):
                raise ApiRefusal(
                    "Bad Request: only the first item of a media group may carry a caption"
                )
        if not definition.get("allowUnknownParameters"):
            unknown = sorted((set(fields) | set(uploads)) - allowed)
            if unknown:
                raise ApiRefusal(
                    "Bad Request: " + unknown[0] + " is not supported yet",
                    parameters={"reason": "unsupported_parameter", "parameter": unknown[0]},
                )
        if method.startswith("send") or method.startswith("editMessage"):
            chat = fields.get("chat_id")
            try:
                if (
                    isinstance(chat, bool)
                    or str(int(chat)) != str(chat)
                    or not -(2**63) <= int(chat) < 2**63
                    or int(chat) == 0
                ):
                    raise ValueError()
            except (ValueError, TypeError):
                raise ApiRefusal("Bad Request: chat not found") from None
        markup = fields.get("reply_markup")
        if markup is not None:
            try:
                markup = self.decoded(markup)
            except (TypeError, ValueError):
                raise ApiRefusal("Bad Request: invalid reply_markup") from None
            if not isinstance(markup, dict):
                raise ApiRefusal("Bad Request: invalid reply_markup")
            if method != "sendMessage" and set(markup) != {"inline_keyboard"}:
                raise ApiRefusal("Bad Request: only inline keyboard is supported")
        if method == "getMe":
            return {
                "id": 7,
                "is_bot": True,
                "first_name": "Fixture",
                "can_join_groups": True,
                "can_read_all_group_messages": False,
                "supports_inline_queries": False,
                "capabilities": {
                    "video_uploads": self.video_uploads,
                    "audio_uploads": False,
                    "single_attach": self.single_attach,
                    "media_groups": True,
                    "chat_actions": False,
                },
            }
        if method == "getUpdates":
            return []
        if method == "getFile":
            ref = fields.get("file_id")
            if ref not in self.assets:
                raise ApiRefusal("Bad Request: wrong file_id specified")
            return {"file_id": ref, "file_unique_id": ref + "-unique", "file_path": ref}
        if method == "getMyCommands":
            return []
        if method in ("sendMessage", "editMessageText"):
            text = fields.get("text", "")
            if not isinstance(text, str) or not text.strip():
                raise ApiRefusal("Bad Request: message text is empty")
            if len(text.encode("utf-16-le")) // 2 > CONTRACT["limits"]["textUtf16"]:
                raise ApiRefusal("Bad Request: message is too long")
            result = {
                "message_id": self.next_id,
                "date": 1,
                "chat": {"id": int(fields["chat_id"]), "type": "private"},
                "text": text,
            }
            self.next_id += 1
            return result
        if method == "sendMediaGroup":
            assert isinstance(media, list)
            sources = [
                self.source(item["type"], item.get("media"), uploads, album=True) for item in media
            ]
            cached_documents = [
                source
                for item, source in zip(media, sources, strict=True)
                if item["type"] == "document" and isinstance(source, str)
            ]
            if len(cached_documents) != len(set(cached_documents)):
                # Observed core constraint: duplicate document IDs do not form an album.
                raise ApiRefusal("Bad Request: message text is empty")
            for item, source in zip(media, sources, strict=True):
                caption = item.get("caption")
                if caption is not None and (
                    not isinstance(caption, str)
                    or len(caption.encode("utf-16-le")) // 2 > CONTRACT["limits"]["captionUtf16"]
                ):
                    raise ApiRefusal("Bad Request: caption is too long")
                if (
                    item["type"] == "photo"
                    and isinstance(source, dict)
                    and source["size"] > CONTRACT["limits"]["photoBytes"]
                ):
                    raise ApiRefusal("Bad Request: file is too big")
            group_id = self.next_id
            results = [
                self.media_message(
                    fields["chat_id"], item["type"], source, item.get("caption"), group_id
                )
                for item, source in zip(media, sources, strict=True)
            ]
            for result in results:
                result["media_group_id"] = str(group_id)
            return results
        if method in ("sendPhoto", "sendDocument", "sendVoice", "sendAudio", "sendVideo"):
            kind = method[4:].lower()
            source = self.source(kind, fields.get(kind), uploads)
            if method == "sendVideo":
                if isinstance(source, str):
                    for key in definition["uploadOnly"]:
                        if key in fields or key in uploads:
                            raise ApiRefusal(
                                "Bad Request: "
                                + key
                                + " applies only to an uploaded video, not to a file identifier",
                                parameters={"reason": "upload_only", "parameter": key},
                            )
                elif not self.video_uploads:
                    raise ApiRefusal(
                        "Bad Request: video must be a file identifier",
                        parameters={"reason": "feature_disabled", "parameter": "video"},
                    )
                elif self.video_retry_count:
                    self.video_retry_count -= 1
                    raise ApiRefusal("Too Many Requests: retry after 10", 429, {"retry_after": 10})
                if "thumbnail" in fields and "thumbnail" not in uploads:
                    thumbnail = self.source("thumbnail", fields["thumbnail"], uploads)
                    if not isinstance(thumbnail, dict):
                        raise ApiRefusal("Bad Request: thumbnail must be an uploaded file")
                for key, maximum in (
                    ("duration", CONTRACT["limits"]["videoDurationSeconds"]),
                    ("width", CONTRACT["limits"]["videoSidePixels"]),
                    ("height", CONTRACT["limits"]["videoSidePixels"]),
                ):
                    if key in fields and (
                        str(fields[key]).isdigit() is False or not 0 <= int(fields[key]) <= maximum
                    ):
                        raise ApiRefusal(
                            f"Bad Request: {key} must be an integer between 0 and {maximum}"
                        )
            if kind == "audio" and isinstance(source, dict):
                raise ApiRefusal("Bad Request: audio must be a file identifier")
            caption = fields.get("caption")
            if (
                caption is not None
                and len(caption.encode("utf-16-le")) // 2 > CONTRACT["limits"]["captionUtf16"]
            ):
                raise ApiRefusal("Bad Request: caption is too long")
            return self.media_message(fields["chat_id"], kind, source, caption)
        if method in (
            "setMyCommands",
            "deleteMyCommands",
            "deleteWebhook",
            "setWebhook",
            "setChatMenuButton",
            "deleteMessage",
            "answerCallbackQuery",
        ):
            if method == "deleteMessage" and (
                not str(fields.get("message_id", "")).isdigit() or "chat_id" not in fields
            ):
                raise ApiRefusal("Bad Request: message to delete not found")
            if method == "setMyCommands":
                commands = self.decoded(fields.get("commands"))
                if not isinstance(commands, list) or len(commands) > 100:
                    raise ApiRefusal("Bad Request: commands must be an array")
            return True
        raise ApiRefusal("Emulator does not model this method: " + method, 501)

    async def handle(self, request):
        method = request.match_info["method"]
        fields, uploads, status = {}, {}, 200
        try:
            fields, uploads = await self.read_request(request)
            result = self.validate(method, fields, uploads)
            body = {"ok": True, "result": result}
        except ApiRefusal as error:
            status = error.status
            body = {"ok": False, "error_code": status, "description": error.description}
            if error.parameters:
                body["parameters"] = error.parameters
        except (ValueError, TypeError, KeyError, UnicodeError):
            status = 400
            body = {"ok": False, "error_code": 400, "description": "Bad Request: malformed request"}
        self.requests.append(
            {"method": method, "fields": sorted(fields), "files": sorted(uploads), "status": status}
        )
        return web.json_response(body, status=status)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--disable-video-uploads", action="store_true")
    parser.add_argument("--legacy-single-attach", action="store_true")
    args = parser.parse_args()
    emulator = LoBotApiEmulator(
        video_uploads=not args.disable_video_uploads, single_attach=not args.legacy_single_attach
    )
    web.run_app(emulator.app(), host="0.0.0.0", port=args.port)
