import assert from "node:assert/strict";
import test from "node:test";
import { runAuthAction } from "./authAction.js";

test("başarılı akışta busy önce açılır sonra kapanır", async () => {
  const setBusyRecords: boolean[] = [];
  const onUnreachableCalls: number[] = [];
  const setBusy = (value: boolean) => setBusyRecords.push(value);
  const onUnreachable = () => onUnreachableCalls.push(1);
  const action = async () => undefined;

  await runAuthAction(setBusy, onUnreachable, action);

  assert.deepEqual(setBusyRecords, [true, false]);
  assert.equal(onUnreachableCalls.length, 0);
});

test("action hata fırlatsa bile busy kapatılır", async () => {
  const setBusyRecords: boolean[] = [];
  const onUnreachableCalls: number[] = [];
  const consoleErrorCalls: unknown[] = [];
  const originalError = console.error;
  try {
    console.error = (...args) => consoleErrorCalls.push(args);
    const setBusy = (value: boolean) => setBusyRecords.push(value);
    const onUnreachable = () => onUnreachableCalls.push(1);
    const action = async () => {
      throw new Error("ağ koptu");
    };

    await runAuthAction(setBusy, onUnreachable, action);
    assert.deepEqual(setBusyRecords, [true, false]);
    assert.equal(onUnreachableCalls.length, 1);
    assert.equal(consoleErrorCalls.length, 1);
    const args = consoleErrorCalls[0] as unknown[];
    assert.equal(args.length, 2);
    assert.equal(args[0], "kimlik doğrulama isteği başarısız:");
    assert.ok(args[1] instanceof Error);
    assert.equal(args[1].message, "ağ koptu");
  } finally {
    console.error = originalError;
  }
});

test("action içindeki erken return busy'yi kapatır", async () => {
  const setBusyRecords: boolean[] = [];
  const onUnreachableCalls: number[] = [];
  const setBusy = (value: boolean) => setBusyRecords.push(value);
  const onUnreachable = () => onUnreachableCalls.push(1);
  const action = async () => undefined;

  await runAuthAction(setBusy, onUnreachable, action);

  assert.deepEqual(setBusyRecords, [true, false]);
  assert.equal(onUnreachableCalls.length, 0);
});

test("busy, action tamamlanmadan kapatılmaz", async () => {
  const setBusyRecords: boolean[] = [];
  let resolvePromise: (() => void) | undefined = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const setBusy = (value: boolean) => setBusyRecords.push(value);
  const onUnreachable = () => {};
  const action = () => promise;

  const runAuthActionPromise = runAuthAction(setBusy, onUnreachable, action);
  assert.deepEqual(setBusyRecords, [true]);
  resolvePromise();
  await runAuthActionPromise;
  assert.deepEqual(setBusyRecords, [true, false]);
});
