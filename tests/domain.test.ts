import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuditEvent,
  verifyAuditChain,
} from "../lib/domain/audit";
import {
  canTransitionCampaign,
  canTransitionRepositoryMigration,
  canTransitionRun,
} from "../lib/domain/states";

test("state machines permit intended approvals and refuse unsafe shortcuts", () => {
  assert.equal(canTransitionCampaign("provider_review", "approved"), true);
  assert.equal(canTransitionCampaign("draft", "live"), false);
  assert.equal(
    canTransitionRepositoryMigration("ready_for_review", "approved_for_pr"),
    true,
  );
  assert.equal(
    canTransitionRepositoryMigration("impact_found", "draft_pr_open"),
    false,
  );
  assert.equal(canTransitionRun("approved", "publishing"), true);
  assert.equal(canTransitionRun("analyzing", "publishing"), false);
});

test("audit chain detects mutated persisted events", async () => {
  const first = await createAuditEvent({
    id: "evt_1",
    organizationId: "org_1",
    aggregateType: "campaign",
    aggregateId: "cmp_1",
    sequence: 1,
    action: "campaign.created",
    actorMembershipId: "mem_1",
    occurredAt: "2026-07-26T00:00:00.000Z",
    payload: { status: "draft" },
    previousHash: null,
  });
  const second = await createAuditEvent({
    id: "evt_2",
    organizationId: "org_1",
    aggregateType: "campaign",
    aggregateId: "cmp_1",
    sequence: 2,
    action: "campaign.approved",
    actorMembershipId: "mem_1",
    occurredAt: "2026-07-26T00:01:00.000Z",
    payload: { specRevision: 1 },
    previousHash: first.eventHash,
  });
  assert.deepEqual(await verifyAuditChain([first, second]), {
    valid: true,
    eventCount: 2,
    rootHash: second.eventHash,
  });
  await assert.rejects(
    verifyAuditChain([
      first,
      {
        ...second,
        payload: { specRevision: 2 },
      },
    ]),
    /hash does not match/,
  );
});
