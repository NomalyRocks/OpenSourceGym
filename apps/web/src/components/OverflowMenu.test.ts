import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverflowMenu } from "./OverflowMenu";

test("overflow menu exposes a named, collapsed menu trigger before interaction", () => {
  const markup = renderToStaticMarkup(
    createElement(OverflowMenu, {
      label: "Period actions",
      items: [
        {
          label: "Cancel period",
          onSelect: () => assert.fail("Unexpected action"),
        },
      ],
    }),
  );
  assert.match(markup, /<button[^>]+type="button"/);
  assert.match(markup, /aria-label="Period actions"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /role="menuitem"|aria-controls=/);
});

test("overflow menu hides the trigger when the caller has no available items", () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(OverflowMenu, { label: "Payment actions", items: [] }),
    ),
    "",
  );
});
