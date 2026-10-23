import assert from "node:assert/strict";
import test from "node:test";
import {
  addPresaleListing,
  countPresaleListings,
  countReferrals,
  getOrCreateUser,
  listPresaleListings,
  openDb,
  recordReferralAttribution,
  removePresaleListing,
} from "../src/db/db.js";

test("presales and referral features persist safely", () => {
  const db = openDb(":memory:");
  try {
    addPresaleListing(db, {
      id: "presale-1",
      title: "Example launch",
      chain: "solana",
      url: "https://example.com/sale",
      details: "Community submission; verify the project independently.",
      created_by: "1",
    });
    assert.equal(listPresaleListings(db).length, 1);
    assert.equal(listPresaleListings(db)[0].chain, "solana");
    assert.equal(removePresaleListing(db, "presale-1"), true);
    assert.equal(removePresaleListing(db, "presale-1"), false);

    for (let index = 1; index <= 4; index += 1) {
      addPresaleListing(db, {
        id: `presale-${index}`,
        title: `Launch ${index}`,
        chain: "evm",
        url: `https://example.com/${index}`,
        details: `Details ${index}`,
        created_by: "1",
      });
    }
    assert.equal(countPresaleListings(db), 4);
    assert.equal(listPresaleListings(db, 2, 0).length, 2);
    assert.equal(listPresaleListings(db, 2, 2).length, 2);
    assert.throws(
      () =>
        addPresaleListing(db, {
          id: "invalid-url",
          title: "Example",
          chain: "evm",
          url: "javascript:alert(1)",
          details: "Details",
          created_by: "1",
        }),
      /HTTP or HTTPS/,
    );
    assert.throws(
      () =>
        addPresaleListing(db, {
          id: "invalid-title",
          title: "x".repeat(81),
          chain: "evm",
          url: "https://example.com",
          details: "Details",
          created_by: "1",
        }),
      /title must be between/,
    );

    getOrCreateUser(db, "10", "referrer", "10");
    getOrCreateUser(db, "20", "invitee");
    assert.equal(recordReferralAttribution(db, "10", "20"), true);
    assert.equal(recordReferralAttribution(db, "10", "20"), false);
    assert.equal(recordReferralAttribution(db, "20", "20"), false);
    assert.equal(countReferrals(db, "10"), 1);

    getOrCreateUser(db, "40", "pending-referrer");
    getOrCreateUser(db, "30", "pending-invitee");
    assert.equal(recordReferralAttribution(db, "40", "30"), false);
    assert.equal(countReferrals(db, "10"), 1);

    getOrCreateUser(db, "50", "flagged-referrer", "50");
    db.prepare("UPDATE users SET admin_flagged = 1 WHERE telegram_id = '50'").run();
    assert.equal(recordReferralAttribution(db, "50", "30"), false);
  } finally {
    db.close();
  }
});
