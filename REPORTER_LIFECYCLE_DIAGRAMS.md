# QOP Reporter — Lifecycle & Integration Diagrams

---

## 1. High-Level: How Every Reporter Plugs In

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        TEST FRAMEWORK LIFECYCLE                          │
│                                                                          │
│   ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ Suite   │    │  Test    │    │  Test    │    │  Suite   │          │
│   │  Start  │───▶│  Start   │───▶│   Body   │───▶│   End    │          │
│   └────┬────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘          │
│        │              │               │               │                 │
│        ▼              ▼               ▼               ▼                 │
│   ┌─────────────────────────────────────────────────────────────┐       │
│   │              QOP REPORTER HOOKS (transparent)               │       │
│   │  onBegin()   onTestBegin()   [no hook here]   onTestEnd()   │       │
│   │  run_started  test_started                   test_finished  │       │
│   └──────────────────────────┬──────────────────────────────────┘       │
│                               │                                          │
└───────────────────────────────┼──────────────────────────────────────────┘
                                │
                    WebSocket: ws://localhost:4000/ws/ingest
                                │
                    ┌───────────▼────────────┐
                    │    QOP Node.js API     │
                    │   (stores, streams,    │
                    │   triggers AI, etc.)   │
                    └────────────────────────┘
```

**Key point**: The reporter has NO visibility into what happens inside the test body.
It only sees: did the whole test pass or fail, and for how long.

---

## 2. Framework-by-Framework Lifecycle Diagrams

### 2a. Playwright

```
Framework Lifecycle              QOP Hook                  WebSocket Event
────────────────────             ────────────              ───────────────
onBegin(config, suite)  ──────▶  onBegin()         ──────▶ run_started
                                                             { totalTests,
                                                               projectNames,
                                                               branch, ci... }

onTestBegin(test)       ──────▶  onTestBegin()     ──────▶ test_started
                                                             { testId, title,
                                                               file, line }

  [test body runs]
  ├── page.goto()
  ├── expect(...)
  ├── helperMethod1()             ← invisible to reporter
  ├── helperMethod2()             ← invisible to reporter
  └── [screenshots on fail]

onTestEnd(test, result) ──────▶  onTestEnd()       ──────▶ test_finished
                                                             { status, durationMs,
                                                               error, attachments }
                                   ↓ waits for ACK
                                   ↓ (backend sends executionId)
                                   ↓
                               upload screenshot
                               PUT /api/screenshots/upload

onEnd()                 ──────▶  onEnd()           ──────▶ run_finished
```

**Registration**: `playwright.config.ts`
```typescript
reporter: [['@qa-observability-platform/playwright']]
```

---

### 2b. Puppeteer / Jest

```
Framework Lifecycle                  QOP Hook                  WebSocket Event
──────────────────────               ────────────              ───────────────
onRunStart(results, options) ──────▶ onRunStart()    ──────▶  run_started
                                                               { totalTests,
                                                                 branch, ci... }

onTestCaseStart(test)        ──────▶ onTestCaseStart()  (no-op — inferred by backend)

  [test body runs]
  ├── puppeteer.launch()
  ├── page.goto()
  ├── helperMethod1()                 ← invisible to reporter
  └── [manual screenshot save]       ← reporter scans ../screenshots/ dir

onTestCaseResult(test,result) ─────▶ onTestCaseResult() ──▶  test_finished
                                                               { status, durationMs,
                                                                 error }
                                        ↓ waits for ACK
                                        ↓ (backend sends executionId)
                                        ↓
                                    find & upload screenshot
                                    from ../screenshots/ directory

onRunComplete()               ─────▶ onRunComplete()  ──────▶ run_finished
```

**Registration**: `jest.config.ts`
```typescript
reporters: ['default', ['@qa-observability-platform/puppeteer/reporter', {}]]
```

---

### 2c. Pytest

```
Framework Lifecycle                      QOP Hook                    WebSocket Event
──────────────────────────               ────────────────            ───────────────
pytest_sessionstart(session)    ──────▶  sessionstart()    ──────▶  run_started
                                                                     { totalTests,
                                                                       branch, ci... }

pytest_runtest_logstart(nodeid) ──────▶  logstart()        ──────▶  test_started
                                                                     { testId, title,
                                                                       file }

  [test body runs — "call" phase]
  ├── browser.new_page()
  ├── page.goto()
  ├── helper_function()                   ← invisible to reporter
  ├── assert ...
  └── [fixture teardown runs after]

pytest_runtest_logreport(report) ─────▶  logreport()       ──────▶  test_finished
  (fires 3x: setup, call, teardown)       when phase=='call'          { status, durationMs,
                                                                         error, longrepr }

pytest_sessionfinish(session)   ──────▶  sessionfinish()   ──────▶  run_finished
```

**Registration**: `conftest.py`
```python
pytest_plugins = ["utils.qop_websocket_reporter"]
```

---

### 2d. Selenium / TestNG

```
TestNG Lifecycle               QOP Hook (ITestListener+ISuiteListener)  WebSocket Event
──────────────────             ────────────────────────────────────────  ───────────────
onStart(ISuite)       ──────▶  onStart()                        ──────▶  run_started
                                                                          { suiteName,
                                                                            totalTests,
                                                                            branch, ci... }

onTestStart(result)   ──────▶  onTestStart()                    ──────▶  test_started
                                                                          { testId: ClassName.method,
                                                                            title, file }

  [@Test method body]
  ├── driver.get(url)
  ├── helper methods()            ← invisible to reporter
  ├── @BeforeMethod, @AfterMethod ← invisible to reporter
  └── [screenshot on fail captured HERE inside onTestFailure]

onTestSuccess(result) ──────▶  onTestSuccess()                  ──────▶  test_finished { passed }
onTestFailure(result) ──────▶  onTestFailure()                  ──────▶  test_finished { failed }
                                  ↓ takes screenshot immediately
                                  ↓ stores as PendingScreenshot
                                  ↓ waits for ACK from backend
                                  ↓
                               upload screenshot
                               PUT /api/screenshots/upload
onTestSkipped(result) ──────▶  onTestSkipped()                  ──────▶  test_finished { skipped }

onFinish(ISuite)      ──────▶  onFinish()                       ──────▶  run_finished
```

**Registration**: `testng.xml`
```xml
<listeners>
  <listener class-name="com.qop.selenium.reporter.QopWebSocketReporter"/>
</listeners>
```

---

## 3. What Happens Inside the Test Body (Invisible Zone)

```
                         ┌─────────────────────────────┐
                         │        TEST BODY             │
                         │                              │
  reporter sees ──▶  START│                              │END ◀── reporter sees
  test_started        │  │  helperMethod1()             │  │   test_finished
                      │  │  helperMethod2()             │  │   (pass/fail as ONE unit)
                      │  │  assertSomething()           │  │
                      │  │  anotherHelper()             │  │
                         │                              │
                         └─────────────────────────────┘
                                       │
                                  REPORTER BLIND ZONE
                         (method-level calls are NOT reported)
```

**The reporter only knows**:
- Did the entire test pass or fail?
- How long did the whole test take?
- What was the final error/stack trace (if failed)?

---

## 4. Scenarios: More Methods / Custom Setups

### Scenario A — Standard Test with Many Helper Methods (works as-is)

```
@Test                                          ┌──────────────┐
def test_checkout_flow():                      │  QOP Backend │
    open_homepage()          ─── all these ─▶  │              │
    login_as_user()              execute        │  test_finished│
    add_to_cart()                inside         │  { status:   │
    apply_coupon()               the test       │    "failed"  │
    proceed_to_checkout()        body           │    error:    │
    assert payment_success()                    │    "Coupon   │
                                                │     invalid" │
                                                └──────────────┘

QOP sees: ONE test — test_checkout_flow — FAILED (error on apply_coupon line)
Reporter reports: The whole test as a single unit. No sub-step visibility.
```

---

### Scenario B — Custom Step Tracking (manual instrumentation needed)

If you want **step-level visibility** inside a test, you must manually call the QOP API:

```
test body                              Manual SDK call              QOP
─────────────────                      ─────────────────            ────────────
open_homepage()         ─────────────▶ qop.step("Open homepage")
login_as_user()         ─────────────▶ qop.step("Login")
add_to_cart()           ─────────────▶ qop.step("Add to cart")
apply_coupon()   ← FAILS                    (fails here)
                         ─────────────▶ qop.step_failed("Coupon error")

                                                                   test_finished +
                                                                   steps: [
                                                                     { name: "Open homepage", status: pass },
                                                                     { name: "Login", status: pass },
                                                                     { name: "Add to cart", status: pass },
                                                                     { name: "Coupon error", status: fail },
                                                                   ]
```

**Status**: This is a FUTURE feature — QOP doesn't currently support step-level events.
The WebSocket protocol would need a `step_started` / `step_finished` event type.

---

### Scenario C — Parameterized Tests (works out-of-the-box)

Each parameter combination becomes a SEPARATE test in QOP:

```
Playwright:
  test.each([['chrome'], ['firefox'], ['safari']])('Login test on %s', ...)
                │                │                │
                ▼                ▼                ▼
  QOP sees:  test_finished   test_finished   test_finished
             "Login test     "Login test     "Login test
              on chrome"      on firefox"     on safari"

Pytest:
  @pytest.mark.parametrize("user", ["admin", "viewer", "guest"])
  def test_login(user):
                │           │           │
                ▼           ▼           ▼
  QOP sees: test_login  test_login  test_login
            [admin]     [viewer]    [guest]

TestNG:
  @DataProvider + @Test
  Each row = separate test_started / test_finished event
```

---

### Scenario D — Custom Test Framework / Runner

If your project uses a custom runner or a framework QOP doesn't support natively:

```
                        Option 1: REST API (simplest)
                        ─────────────────────────────
Your Custom Runner ───▶ POST /api/runs/start
                        POST /api/test-cases/report
                        POST /api/runs/finish
                                │
                                ▼
                           QOP Backend ──▶ Dashboard

                        Option 2: WebSocket directly
                        ─────────────────────────────
Your Custom Runner ───▶ ws://localhost:4000/ws/ingest
                        send { event: 'run_started', ... }
                        send { event: 'test_started', ... }
                        send { event: 'test_finished', ... }
                        send { event: 'run_finished', ... }
                                │
                                ▼
                           QOP Backend ──▶ Dashboard

                        Option 3: Write a reporter plugin
                        ──────────────────────────────────
                        Implement the same WS reporter pattern
                        Map your framework's lifecycle hooks
                        to QOP's 4 events
```

---

### Scenario E — Multiple Test Suites / Nested Describes

```
Playwright:
  describe('Auth')              ← NOT reported as a group
    test('login')               ← reported as individual test
    test('logout')              ← reported as individual test
  describe('Cart')              ← NOT reported as a group
    test('add item')            ← reported as individual test

QOP Dashboard view:
  ┌──────────────────────────┐
  │ Run #42                  │
  │ ├── login         ✅     │
  │ ├── logout        ✅     │
  │ └── add item      ❌     │
  └──────────────────────────┘

  (describe blocks are stripped — test title may include describe prefix
   depending on how title is built, e.g. "Auth > login")
```

---

### Scenario F — BeforeAll / AfterAll / Setup Failures

```
TestNG:
  @BeforeSuite  ← NOT reported (runs before onStart hook)
  @BeforeClass  ← NOT reported as a separate event
  @BeforeMethod ← NOT reported as a separate event
  @Test         ← REPORTED ✅
  @AfterMethod  ← NOT reported as a separate event
  @AfterClass   ← NOT reported as a separate event

Pytest:
  conftest.py setup fixture
    browser = playwright.chromium.launch()     ← NOT reported

  def test_something(browser):
    browser.goto(...)                          ← REPORTED ✅
    assert ...

  conftest.py teardown
    browser.close()                            ← NOT reported
    BUT if teardown fails → test shows ERROR in pytest_runtest_logreport
    QOP captures teardown phase failures as test errors ✅
```

---

## 5. Full Event Flow with Screenshot (Selenium Example)

```
TestNG                QopWebSocketReporter          QOP Node.js API       QOP Dashboard
──────                ────────────────────          ───────────────       ─────────────
@BeforeSuite
  setUp()

onStart(suite) ─────▶ HTTP POST /auth/validate-key
                       ◀── { token, wsUrl }
                       WebSocket connect(wsUrl)
                       ◀── { type: "connected" }
                       send run_started ───────────▶ save run to DB
                                                     broadcast to UI ──▶ Run started

onTestStart ────────▶ send test_started ───────────▶ save test_case   ──▶ Test appears

  @Test runs
  driver.get(url)
  findElement(...)
  FAILS → exception thrown

onTestFailure ──────▶ driver.getScreenshotAs(BYTES)
                       store PendingScreenshot
                       send test_finished (failed) ──▶ save to DB
                                                       send ACK { executionId } ◀──
                       ◀── ACK received
                       PUT /api/screenshots/upload   ──▶ store screenshot
                       (multipart, with executionId)

onFinish ───────────▶ send run_finished ───────────▶ update run status ──▶ Run complete
                       ws.close()
```

---

## 6. What QOP Currently Reports vs. What Needs Custom Work

| Scenario                           | QOP Support     | Notes                                      |
|------------------------------------|-----------------|--------------------------------------------|
| Test pass/fail/skip                | ✅ Built-in     | All 4 frameworks                           |
| Test duration                      | ✅ Built-in     | All 4 frameworks                           |
| Error message + stack trace        | ✅ Built-in     | All 4 frameworks                           |
| Screenshot on failure              | ✅ Built-in     | All 4 frameworks                           |
| Parameterized tests                | ✅ Built-in     | Each param = separate test event           |
| CI/CD metadata (branch, commit)    | ✅ Built-in     | From env vars                              |
| Flaky test detection               | ✅ Built-in     | Computed by Python AI backend              |
| Live execution streaming           | ✅ Built-in     | Playwright, Puppeteer, Pytest (Selenium WIP)|
| Individual helper method tracking  | ❌ Not built-in | Would need manual `qop.step()` SDK calls   |
| @Before/@After hook results        | ⚠️ Partial     | Pytest teardown errors captured; others not|
| Custom test metadata (tags, owners)| ❌ Not built-in | Would need extra fields in test_finished   |
| Step-level screenshots             | ❌ Not built-in | Only final failure screenshot today        |
| Nested describe as groups          | ❌ Not built-in | Titles may include prefix, not grouped     |
