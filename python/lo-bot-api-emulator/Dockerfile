FROM python:3.13-slim@sha256:3dd7cc108ec1493442514f5c2a871af6af0ec31d768ff6e378a93340c3b3db5f
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir . && useradd --uid 10001 --create-home emulator
USER emulator
EXPOSE 8080
CMD ["lo-bot-api-emulator"]
