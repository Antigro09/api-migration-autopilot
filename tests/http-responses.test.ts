import assert from "node:assert/strict";
import test from "node:test";
import { readRequestObject } from "../lib/http/responses";

test("readRequestObject preserves repeated form values", async () => {
  const form = new URLSearchParams();
  form.append("organizationId", "org_customer");
  form.append("validationCategories", "typecheck");
  form.append("validationCategories", "build");
  form.append("validationCategories", "test");

  const request = new Request("https://app.example.test/api/patches", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  assert.deepEqual(await readRequestObject(request), {
    organizationId: "org_customer",
    validationCategories: "typecheck,build,test",
  });
});
