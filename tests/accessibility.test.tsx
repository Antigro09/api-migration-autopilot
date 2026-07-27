import assert from "node:assert/strict";
import test from "node:test";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductShell } from "../app/components/product-shell";
import { MODEL_CONSENT_DISCLOSURE } from "../lib/domain";
import { integrationReadiness } from "../lib/platform/config";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((entry) => entry.name === name)?.value ?? null;
}

function textContent(node: Node): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (isElement(node) && attribute(node, "aria-hidden") === "true") return "";
  return "childNodes" in node
    ? node.childNodes.map((child) => textContent(child)).join(" ")
    : "";
}

function elements(root: Node): Element[] {
  const result: Element[] = [];
  const visit = (node: Node) => {
    if (isElement(node)) result.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(root);
  return result;
}

function hasAncestorLabel(element: Element): boolean {
  let parent: Node | null = element.parentNode;
  while (parent) {
    if (isElement(parent) && parent.tagName === "label") return true;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return false;
}

function assertAccessibleShell(markup: string, label: string): void {
  const document = parseFragment(markup);
  const all = elements(document);
  const ids = all
    .map((element) => attribute(element, "id"))
    .filter((id): id is string => Boolean(id));
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate element IDs`);
  assert.equal(
    all.filter((element) => element.tagName === "main").length,
    1,
    `${label}: expected one main landmark`,
  );
  assert.ok(
    all.some(
      (element) =>
        element.tagName === "nav" &&
        Boolean(attribute(element, "aria-label")),
    ),
    `${label}: navigation must have an accessible label`,
  );

  const labelsByFor = new Set(
    all
      .filter((element) => element.tagName === "label")
      .map((element) => attribute(element, "for"))
      .filter((value): value is string => Boolean(value)),
  );
  for (const element of all) {
    if (element.tagName === "button") {
      assert.ok(
        ["button", "submit"].includes(attribute(element, "type") ?? ""),
        `${label}: every button must declare its type`,
      );
    }
    if (["button", "a"].includes(element.tagName)) {
      const name =
        attribute(element, "aria-label") ?? textContent(element).trim();
      assert.ok(name, `${label}: ${element.tagName} is missing an accessible name`);
    }
    if (
      ["input", "select", "textarea"].includes(element.tagName) &&
      attribute(element, "type") !== "hidden"
    ) {
      const id = attribute(element, "id");
      const labelled =
        Boolean(attribute(element, "aria-label")) ||
        Boolean(attribute(element, "aria-labelledby")) ||
        hasAncestorLabel(element) ||
        Boolean(id && labelsByFor.has(id));
      assert.ok(
        labelled,
        `${label}: ${element.tagName}[name=${attribute(element, "name") ?? ""}] is not labelled`,
      );
    }
  }
}

const actor = {
  id: "usr_accessibility",
  email: "founder@example.com",
  displayName: "Founder",
  platformRole: "admin",
  authenticationMethod: "local-development",
} as const;

const views = {
  provider: ["overview", "campaigns", "spec", "invitations", "audit"],
  customer: ["migrations", "impact", "patch", "policies", "audit"],
  operations: ["overview", "runs", "audit"],
} as const;

for (const surface of ["provider", "customer", "operations"] as const) {
  for (const requestedView of views[surface]) {
    test(`${surface}/${requestedView} exposes keyboard and screen-reader landmarks`, () => {
      const markup = renderToStaticMarkup(
        <ProductShell
          surface={surface}
          requestedView={requestedView}
          workspace={{
            organizationId: `org_${surface}`,
            membershipId: `mem_${surface}`,
            name: `${surface} workspace`,
            kind: surface === "operations" ? "internal" : surface,
            role: "admin",
            verifiedDomain: null,
            providerBrandingApprovedAt: null,
          }}
          actor={actor}
          consentDisclosure={MODEL_CONSENT_DISCLOSURE}
          integrations={integrationReadiness()}
        />,
      );
      assertAccessibleShell(markup, `${surface}/${requestedView}`);
      assert.match(markup, /id="product-content" tabindex="-1"/);
    });
  }
}
