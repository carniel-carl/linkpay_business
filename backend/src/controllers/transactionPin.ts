import type { RequestHandler } from "express";
import { z } from "zod";
import { changePin, pinSchema, pinStatus, requestPinReset, resetPin, setFirstPin } from "../services/transactionPin";

// The signed-in user's own transaction PIN. Every response is the PIN's status; the PIN and its hash never leave.

const password = z.string().min(1).max(128);
const code = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");

/** `{ isSet, locked, lockedUntil, attemptsLeft, changedAt }` */
export const getTransactionPinStatus: RequestHandler = async (req, res) => {
  res.json(await pinStatus(req.userId!));
};

/** The first PIN: `{ pin, password }`. */
export const setTransactionPin: RequestHandler = async (req, res) => {
  const body = z.object({ pin: pinSchema, password }).parse(req.body);
  await setFirstPin(req.userId!, body.password, body.pin);
  res.status(201).json(await pinStatus(req.userId!));
};

/** `{ newPin, currentPin }` or `{ newPin, password }`. */
export const changeTransactionPin: RequestHandler = async (req, res) => {
  const body = z
    .union([
      z.object({ newPin: pinSchema, currentPin: pinSchema }).strict(),
      z.object({ newPin: pinSchema, password }).strict(),
    ])
    .parse(req.body);
  await changePin(req.userId!, "currentPin" in body ? { currentPin: body.currentPin } : { password: body.password }, body.newPin);
  res.json(await pinStatus(req.userId!));
};

/** Emails a reset code to the signed-in user. */
export const requestTransactionPinReset: RequestHandler = async (req, res) => {
  const sentTo = await requestPinReset(req.userId!);
  res.json({ message: "We've emailed you a 6-digit code. It expires in 10 minutes.", sentTo });
};

/** A forgotten or locked PIN: `{ password, code, newPin }`. */
export const resetTransactionPin: RequestHandler = async (req, res) => {
  const body = z.object({ password, code, newPin: pinSchema }).parse(req.body);
  await resetPin(req.userId!, body.password, body.code, body.newPin);
  res.json(await pinStatus(req.userId!));
};
