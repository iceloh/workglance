// Protocol eval scenarios: does the agent keep the board the way the protocol says?
// Each runs in a throwaway repo against an isolated workglance. Adapted in spirit from Conus's scenario
// set (github.com/Pandusss/conus, MIT); the expectations follow OUR protocol text.

export type BoardTask = { id: number; title: string; type: string; status: string; result: string | null };
export type Board = { tasks: BoardTask[]; nudges: number; edits: number };
export type Check = (b: Board) => { fail?: string; warn?: string } | null;

export type Scenario = {
  name: string;
  why: string;
  files: Record<string, string>;
  turns: string[];
  /** Checks after a given turn (index), e.g. "no card yet after the brainstorm". */
  after?: Record<number, Check[]>;
  /** Checks at the end. */
  expect: Check[];
};

const APP = `def greet(name):\n    return "Hello " + name\n`;

// Small check helpers: a failure message, or null when fine.
const tasksCount = (n: number): Check => (b) => (b.tasks.length === n ? null : { fail: `expected ${n} card(s), got ${b.tasks.length}: ${b.tasks.map((t) => `"${t.title}" (${t.type}/${t.status})`).join(", ")}` });
const atMost = (n: number): Check => (b) => (b.tasks.length <= n ? null : { fail: `expected at most ${n} card(s), got ${b.tasks.length}` });
const some = (label: string, p: (t: BoardTask) => boolean): Check => (b) => (b.tasks.some(p) ? null : { fail: `no card that ${label}` });
const soft = (c: Check, why: string): Check => (b) => { const r = c(b); return r?.fail ? { warn: `${why}: ${r.fail}` } : null; };
const noEdits: Check = (b) => (b.edits === 0 ? null : { fail: `expected no file changes, got ${b.edits} edit(s)` });

export const SCENARIOS: Scenario[] = [
  {
    name: "question_no_card",
    why: "A question answered in a step or two is never a task.",
    files: { "app.py": APP },
    turns: ["Explain briefly what greet() in app.py does. Don't change anything."],
    expect: [tasksCount(0)],
  },
  {
    name: "feature_lifecycle",
    why: "Real work becomes one feature card, closed (or in testing) with a real result.",
    files: { "app.py": APP },
    turns: ["Add farewell(name) and shout(name) functions to app.py, with pytest tests in test_app.py. Run the tests, then commit everything."],
    expect: [atMost(1), some("is a feature", (t) => t.type === "feature"),
      some("is done or testing with a result of 40+ chars", (t) => ["done", "testing"].includes(t.status) && (t.result ?? "").trim().length >= 40)],
  },
  {
    name: "small_edit_no_card",
    why: "A small one-off edit is not a task (even if the end-of-turn nudge fires, the agent should decline).",
    files: { "app.py": `def greet(name):\n    return "Helo " + name\n` },
    turns: ["Fix the typo 'Helo' in app.py."],
    expect: [tasksCount(0)],
  },
  {
    name: "brainstorm_then_agree",
    why: "No card while comparing options; a card once the user agrees to do it.",
    files: { "app.py": APP },
    turns: [
      "I'm thinking about adding a config file to this project. JSON or TOML? Just give me your opinion in a few sentences; don't change anything yet.",
      "Ok, let's go with JSON: add loading of config.json in app.py (with a default when the file is missing) and a pytest test for it.",
    ],
    after: { 0: [tasksCount(0)] },
    expect: [some("covers the config work", (t) => /config|json/i.test(t.title))],
  },
  {
    name: "agreed_for_later",
    why: "Agreed but not started now: a planned card, no code changes.",
    files: { "app.py": APP },
    turns: ["Let's plan to add a CSV export to this project next week. Don't do it now, just keep it on the list."],
    expect: [tasksCount(1), some("is planned", (t) => t.status === "planned"), noEdits],
  },
  {
    name: "user_says_not_a_task",
    why: "\"Not a task\" from the user overrides everything.",
    files: { "app.py": APP },
    turns: ["Add __version__ = '0.1.0' at the top of app.py. This is not a task, don't track it."],
    expect: [tasksCount(0)],
  },
  {
    name: "investigation_with_findings",
    why: "An investigation the user asked for is a card, and its result IS the findings.",
    // A real audit (several files), not a glance at one: the protocol counts investigations that take real work.
    files: {
      "app.py": `from users import find_user\nfrom calc import calc\nfrom files import read_report\n\ndef handle(req, db):\n    if req["action"] == "user":\n        return find_user(db, req["name"])\n    if req["action"] == "calc":\n        return calc(req["expr"])\n    return read_report(req["file"])\n`,
      "users.py": `PASSWORD = "admin123"\n\ndef find_user(db, name):\n    return db.execute("SELECT * FROM users WHERE name = '" + name + "'").fetchall()\n\ndef login(user, pw):\n    return pw == PASSWORD\n`,
      "calc.py": `def calc(expr):\n    return eval(expr)\n`,
      "files.py": `import os\n\ndef read_report(name):\n    return open(os.path.join("reports", name)).read()\n`,
      "settings.py": `DEBUG = True\nSECRET_KEY = "dev"\nALLOWED_HOSTS = ["*"]\n`,
    },
    turns: ["Do a security audit of this whole project and report what you find, with file and line for each issue. Don't fix anything."],
    expect: [some("is an investigation", (t) => t.type === "investigation"),
      some("has findings in its result (password, SQL injection or eval)", (t) => (t.result ?? "").length >= 80 && /password|sql|inject|eval/i.test(t.result ?? "")),
      noEdits],
  },
  {
    name: "investigation_unfinished",
    why: "An investigation the user says continues later stays open: the end-of-turn reminder must not push it closed.",
    files: {
      "users.py": `PASSWORD = "admin123"\n\ndef find_user(db, name):\n    return db.execute("SELECT * FROM users WHERE name = '" + name + "'").fetchall()\n`,
      "calc.py": `def calc(expr):\n    return eval(expr)\n`,
      "files.py": `import os\n\ndef read_report(name):\n    return open(os.path.join("reports", name)).read()\n`,
    },
    turns: ["Start a security audit of this project. Today only users.py: tell me what you find there, with lines. We continue with calc.py and files.py tomorrow. Don't fix anything."],
    expect: [soft(some("is an investigation", (t) => t.type === "investigation"), "the partial audit got no card"),
      (b) => (b.tasks.some((t) => t.type === "investigation" && t.status === "done") ? { fail: "the unfinished investigation was closed as done" } : null),
      noEdits],
  },
  {
    name: "bug_found_midway",
    why: "An unrelated bug found mid-task becomes its own card for later (soft: fixing or mentioning it is also defensible).",
    files: {
      "app.py": APP,
      "utils.py": `def divide(a, b):\n    return a * b  # BUG: should be a / b\n`,
    },
    turns: ["Add a percent(part, total) helper to app.py that returns part/total*100 using utils.divide, with a pytest test. Only do this; don't fix other things in this turn."],
    expect: [some("is the percent feature", (t) => /percent/i.test(t.title)),
      soft(some("is a separate bug card", (t) => t.type === "bug"), "bug noticed but not carded")],
  },
];
