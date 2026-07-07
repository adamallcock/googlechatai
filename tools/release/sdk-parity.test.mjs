import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  camelToSnake,
  compareRouterMethods,
  extractNodeRouterClassBody,
  nodeRouterMethods,
  parsePublicClassMethodNames,
  pythonRouterMethods,
} from "./check-sdk-parity.mjs";

test("root SDK export parity checker passes for intentional Node/Python differences", () => {
  const result = spawnSync("node", ["tools/release/check-sdk-parity.mjs", "--json"], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.missingPython.length, 0);
  assert.equal(payload.missingNode.length, 0);
  assert.equal(payload.routerMissingPython.length, 0);
  assert.equal(payload.routerMissingNode.length, 0);
});

test("router method surface stays in sync between the real Node and Python GoogleChatAI classes", () => {
  const { routerMissingPython, routerMissingNode } = compareRouterMethods({
    nodeMethods: nodeRouterMethods(),
    pythonMethods: pythonRouterMethods(),
  });

  assert.deepEqual(routerMissingPython, []);
  assert.deepEqual(routerMissingNode, []);
});

test("nodeRouterMethods() extracts the real GoogleChatAI router's public method names", () => {
  const methods = nodeRouterMethods();

  // A representative sample of dedicated `on*` registration methods, the
  // generic `on`/`use` methods, and the async HTTP entrypoints.
  for (const expected of [
    "on",
    "use",
    "onMention",
    "onAddedToSpace",
    "onSlashCommand",
    "fetch",
    "handlePayload",
    "handleEvent",
  ]) {
    assert.ok(methods.includes(expected), `expected nodeRouterMethods() to include "${expected}"`);
  }

  // Private fields/methods and the constructor must never leak in.
  for (const excluded of [
    "constructor",
    "createHandlerContext",
    "runWithDeadline",
    "runMiddlewareChain",
    "dispatchToHandlers",
    "handlersForEvent",
    "source",
    "middlewares",
  ]) {
    assert.ok(!methods.includes(excluded), `expected nodeRouterMethods() to exclude "${excluded}"`);
  }
});

test("extractNodeRouterClassBody() isolates only the named class body, ignoring braces before and after it", () => {
  const source = `
export interface Unrelated {
  nested: { a: number };
}

function helperBeforeClass() {
  if (true) {
    return { ok: true };
  }
}

export class GoogleChatAI {
  use(middleware) {
    return this;
  }

  async fetch(request) {
    if (request) {
      return { status: 200 };
    }
    return { status: 400 };
  }
}

export class SomethingElseAfter {
  otherMethod() {
    return null;
  }
}
`;

  const body = extractNodeRouterClassBody(source);

  assert.ok(body.includes("use(middleware)"));
  assert.ok(body.includes("async fetch(request)"));
  assert.ok(!body.includes("otherMethod"));
  assert.ok(!body.includes("helperBeforeClass"));
});

test("extractNodeRouterClassBody() throws a descriptive error when the class is not found", () => {
  assert.throws(
    () => extractNodeRouterClassBody("export class SomethingElse {}", "GoogleChatAI"),
    /Could not find "export class GoogleChatAI/,
  );
});

test("parsePublicClassMethodNames() extracts only public method declarations from a fixture class body", () => {
  const classBody = `
  readonly source: string;
  private readonly appUser: unknown | undefined;
  private readonly middlewares: unknown[] = [];
  #trulyPrivateField = 1;

  constructor(options = {}) {
    this.source = options.source;
  }

  use(middleware) {
    this.middlewares.push(middleware);
    return this;
  }

  onMention(handler) {
    this.mentionHandlers.push(handler);
    return this;
  }

  onSlashCommand(handler) {
    return this;
  }

  async fetch(request) {
    return this.handlePayload(await request.json());
  }

  async handlePayload(
    rawPayload,
    options = {},
  ) {
    return this.handleEvent(rawPayload, options);
  }

  get isReady() {
    return true;
  }

  set isReady(value) {
    this._ready = value;
  }

  static create(options) {
    return new GoogleChatAI(options);
  }

  private createHandlerContext(event) {
    return { event };
  }

  private async runWithDeadline(event, context) {
    if (this.deadline) {
      return context;
    }
    return context;
  }

  #trulyPrivateMethod() {
    return null;
  }
`;

  const methods = [...parsePublicClassMethodNames(classBody)].sort();

  assert.deepEqual(methods, ["fetch", "handlePayload", "onMention", "onSlashCommand", "use"].sort());
});

test("parsePublicClassMethodNames() dedupes overload signature lines that share a name with their implementation", () => {
  const classBody = `
  onSlashCommand(handler);
  onSlashCommand(commandName, handler);
  onSlashCommand(commandNameOrHandler, maybeHandler) {
    return this;
  }
`;

  const methods = [...parsePublicClassMethodNames(classBody)];

  assert.deepEqual(methods, ["onSlashCommand"]);
});

test("compareRouterMethods() reports no drift when every shared Node method converts cleanly to its Python name", () => {
  const result = compareRouterMethods({
    nodeMethods: ["on", "onMention", "onAddedToSpace", "fetch", "handlePayload", "handleEvent", "use"],
    pythonMethods: ["on", "on_mention", "on_added_to_space", "dispatch", "dispatch_async"],
  });

  assert.deepEqual(result.routerMissingPython, []);
  assert.deepEqual(result.routerMissingNode, []);
});

test("compareRouterMethods() flags a Node method with no Python counterpart", () => {
  const result = compareRouterMethods({
    nodeMethods: ["on", "onMention", "onNewNodeOnlyMethod"],
    pythonMethods: ["on", "on_mention"],
  });

  assert.deepEqual(result.routerMissingPython, ["on_new_node_only_method"]);
  assert.deepEqual(result.routerMissingNode, []);
});

test("compareRouterMethods() flags a renamed Python method as missing on both sides (drift reproduction)", () => {
  // Mirrors the manual reproduction used against the real runtime.py: rename
  // on_mention -> on_mentioned and confirm the checker reports the expected
  // Python name as missing and the orphaned renamed method as unexpected.
  const result = compareRouterMethods({
    nodeMethods: ["on", "onMention", "onAddedToSpace"],
    pythonMethods: ["on", "on_mentioned", "on_added_to_space"],
  });

  assert.deepEqual(result.routerMissingPython, ["on_mention"]);
  assert.deepEqual(result.routerMissingNode, ["on_mentioned"]);
});

test("compareRouterMethods() does not flag Node-only or Python-only router methods declared as intentional", () => {
  const result = compareRouterMethods({
    nodeMethods: ["on", "onMention", "use", "fetch", "handlePayload", "handleEvent"],
    pythonMethods: ["on", "on_mention", "dispatch", "dispatch_async"],
  });

  assert.deepEqual(result.routerMissingPython, []);
  assert.deepEqual(result.routerMissingNode, []);
});

test("camelToSnake() converts every real shared GoogleChatAI method name to its Python form", () => {
  const cases = new Map([
    ["onMessage", "on_message"],
    ["onMention", "on_mention"],
    ["onCardClicked", "on_card_clicked"],
    ["onDialogSubmitted", "on_dialog_submitted"],
    ["onDialogCancelled", "on_dialog_cancelled"],
    ["onWidgetUpdated", "on_widget_updated"],
    ["onLinkPreview", "on_link_preview"],
    ["onAddedToSpace", "on_added_to_space"],
    ["onRemovedFromSpace", "on_removed_from_space"],
    ["onReactionCreated", "on_reaction_created"],
    ["onReactionDeleted", "on_reaction_deleted"],
    ["onMembershipCreated", "on_membership_created"],
    ["onMembershipUpdated", "on_membership_updated"],
    ["onMembershipDeleted", "on_membership_deleted"],
    ["onMessageUpdated", "on_message_updated"],
    ["onMessageDeleted", "on_message_deleted"],
    ["onUnknownEvent", "on_unknown_event"],
    ["onSlashCommand", "on_slash_command"],
    ["on", "on"],
  ]);

  for (const [nodeName, expectedPythonName] of cases) {
    assert.equal(camelToSnake(nodeName), expectedPythonName);
  }
});
