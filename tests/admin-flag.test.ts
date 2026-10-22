import assert from "node:assert/strict";
import test from "node:test";
import {
  getOrCreateUser,
  getUser,
  openDb,
  setUserAdminFlag,
} from "../src/db/db.js";

test("admin flags block users independently of their optional message", () => {
  const db = openDb(":memory:");
  try {
    getOrCreateUser(db, "42", "user42", "1");

    setUserAdminFlag(db, "42", true, null);
    const flaggedWithoutMessage = getUser(db, "42");
    assert.equal(flaggedWithoutMessage?.admin_flagged, 1);
    assert.equal(flaggedWithoutMessage?.admin_flag_message, null);

    setUserAdminFlag(db, "42", true, "Please contact support.");
    const flaggedWithMessage = getUser(db, "42");
    assert.equal(flaggedWithMessage?.admin_flagged, 1);
    assert.equal(flaggedWithMessage?.admin_flag_message, "Please contact support.");

    setUserAdminFlag(db, "42", false, null);
    const unflagged = getUser(db, "42");
    assert.equal(unflagged?.admin_flagged, 0);
    assert.equal(unflagged?.admin_flag_message, null);
  } finally {
    db.close();
  }
});
