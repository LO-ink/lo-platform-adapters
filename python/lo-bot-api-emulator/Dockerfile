FROM python:3.13.16-alpine3.24@sha256:2d9aefe2fef018a7eb2c13064c89c71929800fd2e5dccdbf52ea5da5bb8d929a
RUN apk upgrade --no-cache
WORKDIR /app
COPY . .
# Package installers are only needed while building the fixture.
RUN pip install --no-cache-dir --only-binary=:all: . \
    && python -m pip uninstall --yes pip \
    && rm -rf /usr/local/lib/python3.13/ensurepip \
    && adduser -D -u 10001 emulator
USER emulator
EXPOSE 8080
CMD ["lo-bot-api-emulator", "--host", "0.0.0.0"]
