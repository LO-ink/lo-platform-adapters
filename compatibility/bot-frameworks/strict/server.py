import asyncio
from aiohttp import web
from lo_bot_api_emulator import LoBotApiEmulator

async def main():
    runner = web.AppRunner(LoBotApiEmulator().app())
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    print(f'http://127.0.0.1:{runner.addresses[0][1]}', flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()

asyncio.run(main())
