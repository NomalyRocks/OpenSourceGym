import assert from "node:assert/strict";
import test from "node:test";
import { runAuthAction } from "./authAction.js";

test("sets busy before a successful flow and clears it afterward", async () => {
  const setBusyRecords: boolean[] = [];
  const onUnreachableCalls: number[] = [];
  const setBusy = (value: boolean) => setBusyRecords.push(value);
  const onUnreachable = () => onUnreachableCalls.push(1);
  const action = async () => undefined;

  await runAuthAction(setBusy, onUnreachable, action);

  assert.deepEqual(setBusyRecords, [true, false]);
  assert.equal(onUnreachableCalls.length, 0);
});

test("clears busy even when the action throws", async () => {
  const setBusyRecords: boolean[] = [];
  const onUnreachableCalls: number[] = [];
  const consoleErrorCalls: unknown[] = [];
  const originalError = console.error;
  try {
    console.error = (...args) => consoleErrorCalls.push(args);
    const setBusy = (value: boolean) => setBusyRecords.push(value);
    const onUnreachable = () => onUnreachableCalls.push(1);
    const action = async () => {
      throw new Error("network disconnected");
    };

    await runAuthAction(setBusy, onUnreachable, action);
    assert.deepEqual(setBusyRecords, [true, false]);
    assert.equal(onUnreachableCalls.length, 1);
    assert.equal(consoleErrorCalls.length, 1);
    const args = consoleErrorCalls[0] as unknown[];
    assert.equal(args.length, 2);
    assert.equal(args[0], "authentication request failed:");
    assert.ok(args[1] instanceof Error);
    assert.equal(args[1].message, "network disconnected");
  } finally {
    console.error = originalError;
  }
});

test("clears busy after an early return from the action", async () => {
  const setBusyRecords: boolean[] = [];
  const onUnreachableCalls: number[] = [];
  const setBusy = (value: boolean) => setBusyRecords.push(value);
  const onUnreachable = () => onUnreachableCalls.push(1);
  const action = async () => undefined;

  await runAuthAction(setBusy, onUnreachable, action);

  assert.deepEqual(setBusyRecords, [true, false]);
  assert.equal(onUnreachableCalls.length, 0);
});

test("does not clear busy before the action completes", async () => {
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
