import test from "node:test";
import assert from "node:assert/strict";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";
import { createWebAppAdapter } from "../dist/index.js";

function clientFor(host) {
  return createMiniAppClient(
    createWebAppAdapter(
      "response-fixture",
      host,
      new Set(["popup", "clipboard", "biometry", "location"]),
    ),
  );
}
const invalidResponse = (error) => error.code === "invalid-response";

test("popup and clipboard preserve cancellation and empty strings but reject malformed values", async () => {
  let result;
  const client = clientFor({
    showPopup: (_params, done) => done(result),
    readTextFromClipboard: (done) => done(result),
  });
  for (const value of ["button", "", null]) {
    result = value;
    assert.equal(
      await client.call("showPopup", { message: "x" }),
      value ?? undefined,
    );
    assert.equal(await client.call("readClipboard", undefined), value);
  }
  result = undefined;
  assert.equal(await client.call("showPopup", { message: "x" }), undefined);
  await assert.rejects(
    client.call("readClipboard", undefined),
    invalidResponse,
  );
  for (const value of [0, false, true, {}, [], NaN]) {
    result = value;
    await assert.rejects(
      client.call("showPopup", { message: "x" }),
      invalidResponse,
    );
    await assert.rejects(
      client.call("readClipboard", undefined),
      invalidResponse,
    );
  }
  client.dispose();
});

test("biometry preserves official boolean/null callbacks and validates both result fields", async () => {
  let result;
  const client = clientFor({
    BiometricManager: { authenticate: (_params, done) => done(...result) },
  });
  for (const [args, expected] of [
    [[false, null], { authenticated: false }],
    [[false], { authenticated: false }],
    [[true, ""], { authenticated: true, token: "" }],
    [[true, "token"], { authenticated: true, token: "token" }],
    [[true], { authenticated: true }],
    [[true, null], { authenticated: true }],
  ]) {
    result = args;
    assert.deepEqual(await client.call("authenticateBiometry", {}), expected);
  }
  for (const args of [
    ["true", "token"],
    [0],
    [null],
    [undefined],
    [true, 17],
    [false, {}],
  ]) {
    result = args;
    await assert.rejects(
      client.call("authenticateBiometry", {}),
      invalidResponse,
    );
  }
  client.dispose();
});

test("location preserves null denial, boundaries, zero and unavailable measurements", async () => {
  let result = null;
  const client = clientFor({
    LocationManager: { isInited: true, getLocation: (done) => done(result) },
  });
  assert.equal(await client.call("getLocation", undefined), null);
  for (const [latitude, longitude] of [
    [0, 0],
    [-90, -180],
    [90, 180],
  ]) {
    result = { latitude, longitude };
    assert.deepEqual(await client.call("getLocation", undefined), {
      latitude,
      longitude,
      altitude: null,
      course: null,
      speed: null,
      horizontalAccuracy: null,
      verticalAccuracy: null,
      courseAccuracy: null,
      speedAccuracy: null,
    });
  }
  result = {
    latitude: 12,
    longitude: 34,
    altitude: -10,
    course: 0,
    speed: 0,
    horizontal_accuracy: 0,
    vertical_accuracy: 0,
    course_accuracy: 0,
    speed_accuracy: 0,
  };
  assert.deepEqual(await client.call("getLocation", undefined), {
    latitude: 12,
    longitude: 34,
    altitude: -10,
    course: 0,
    speed: 0,
    horizontalAccuracy: 0,
    verticalAccuracy: 0,
    courseAccuracy: 0,
    speedAccuracy: 0,
  });
  for (const invalid of [
    undefined,
    false,
    [],
    {},
    { latitude: 0, longitude: 181 },
    { latitude: -91, longitude: 0 },
    { latitude: NaN, longitude: 0 },
    { latitude: 0, longitude: Infinity },
    { latitude: "0", longitude: 0 },
  ]) {
    result = invalid;
    await assert.rejects(
      client.call("getLocation", undefined),
      invalidResponse,
    );
  }
  for (const key of [
    "altitude",
    "course",
    "speed",
    "horizontal_accuracy",
    "vertical_accuracy",
    "course_accuracy",
    "speed_accuracy",
  ]) {
    for (const value of [NaN, Infinity, "0", false, {}]) {
      result = { latitude: 0, longitude: 0, [key]: value };
      await assert.rejects(
        client.call("getLocation", undefined),
        invalidResponse,
      );
    }
    result = { latitude: 0, longitude: 0, [key]: null };
    await client.call("getLocation", undefined);
  }
  client.dispose();
});
