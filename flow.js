/*
 * ============================================================
 *   QOP — Reporter Test Lifecycle & Full Data Flow
 * ============================================================
 *
 *
 *  FRAMEWORK HOOKS  ──►  QOP EVENTS  ──►  Node.js  ──►  DB / FastAPI
 *
 * ============================================================
 *
 *
 *  ┌─────────────────────────────────────────────────────────────────────────────┐
 *  │  PLAYWRIGHT                         PUPPETEER (Jest)                        │
 *  │  Reporter: QopWsReporter            Reporter: Jest Custom Reporter           │
 *  │                                                                             │
 *  │  onBegin()      ──► run_started     onRunStart()     ──► run_started        │
 *  │  onTestBegin()  ──► test_started    onTestStart()    ──► test_started       │
 *  │  onTestEnd()    ──► test_finished   onTestResult()   ──► test_finished      │
 *  │  onEnd()        ──► run_finished    onRunComplete()  ──► run_finished       │
 *  └─────────────────────────────────────────────────────────────────────────────┘
 *
 *  ┌─────────────────────────────────────────────────────────────────────────────┐
 *  │  SELENIUM (TestNG)                  PYTEST                                  │
 *  │  Reporter: QopWebSocketReporter     Reporter: pytest plugin                 │
 *  │  Hooks: ITestListener+ISuiteListener                                        │
 *  │                                                                             │
 *  │  onStart(suite) ──► run_started     pytest_runtest_logstart  ──► run_started│
 *  │  onTestStart()  ──► test_started    pytest_runtest_logreport ──► test_started│
 *  │  onTestSuccess()──► test_finished   pytest_runtest_makereport──► test_finished│
 *  │  onTestFailure()──► test_finished   pytest_sessionfinish     ──► run_finished│
 *  │  onTestSkipped()──► test_finished                                           │
 *  │  onFinish(suite)──► run_finished                                            │
 *  └─────────────────────────────────────────────────────────────────────────────┘
 *
 *
 * ============================================================
 *  WEBSOCKET EVENT PAYLOAD (what each event sends)
 * ============================================================
 *
 *  run_started   ──►  { event, runId, suiteName, totalTests,
 *                        branch, commitSha, ciBuildNumber, environment }
 *
 *  test_started  ──►  { event, runId, testId, title, file, timestamp }
 *
 *  test_finished ──►  { event, runId, testId, title, file,
 *                        status: "passed" | "failed" | "skipped",
 *                        durationMs,
 *                        error: { message, stack }  ← only on failure }
 *
 *  run_finished  ──►  { event, runId, suiteName, timestamp }
 *
 *
 * ============================================================
 *  FULL DATA FLOW DIAGRAM
 * ============================================================
 *
 *
 *   ┌──────────────┐
 *   │  Playwright  │ ──┐
 *   │  onBegin     │   │
 *   │  onTestBegin │   │
 *   │  onTestEnd   │   │
 *   │  onEnd       │   │
 *   └──────────────┘   │
 *                      │
 *   ┌──────────────┐   │
 *   │  Puppeteer   │   │   WebSocket
 *   │  onRunStart  │ ──┼──  /ws/ingest  ──────────────────►  ┌─────────────────────┐
 *   │  onTestStart │   │   (WS events)                       │    Node.js API      │
 *   │  onTestResult│   │                                     │    port 4000        │
 *   │  onRunComplete   │                                     │                     │
 *   └──────────────┘   │                                     │  automationServer   │
 *                      │                                     │  liveServer         │
 *   ┌──────────────┐   │                                     └────────┬────────────┘
 *   │  Pytest      │ ──┤                                              │
 *   │  logstart    │   │                                              │
 *   │  logreport   │   │                         ┌────────────────────┼──────────────────┐
 *   │  makereport  │   │                          │                   │                  │
 *   │  sessionfinish   │                          ▼                   ▼                  ▼
 *   └──────────────┘   │                  INSERT run            INSERT test       INSERT screenshot
 *                      │                  test_runs             case_executions   (on failure)
 *   ┌──────────────┐   │                          │                   │                  │
 *   │  Selenium    │ ──┘                          └────────────────────┼──────────────────┘
 *   │  onStart     │                                                   │
 *   │  onTestStart │                                                   ▼
 *   │  onTestSuccess                                       ┌───────────────────────┐
 *   │  onTestFailure                                       │      PostgreSQL        │
 *   │  onTestSkipped                                       │                       │
 *   │  onFinish    │                                       │  test_runs             │
 *   └──────────────┘                                       │  test_case_executions  │
 *                                                          │  test_stability_metrics│
 *                                                          │  screenshots           │
 *                                                          └───────────┬────────────┘
 *                                                                      │
 *                                                                      │  HTTP
 *                                                                      │  (aiAnalysisClient.ts)
 *                                                                      ▼
 *                                                          ┌───────────────────────┐
 *                                                          │   FastAPI  port 8000  │
 *                                                          │                       │
 *                                                          │  Claude  (Anthropic)  │
 *                                                          │  GPT     (OpenAI)     │
 *                                                          │  Gemini  (Google)     │
 *                                                          │                       │
 *                                                          │  ► Failure Analysis   │
 *                                                          │  ► Flaky Detection    │
 *                                                          │  ► Stability Score    │
 *                                                          └───────────┬───────────┘
 *                                                                      │
 *                                                                      │ writes back
 *                                                                      ▼
 *                                                          ┌───────────────────────┐
 *                                                          │      PostgreSQL        │
 *                                                          │  (analysis results)   │
 *                                                          └───────────────────────┘
 *
 *
 * ============================================================
 *  SCREENSHOT LIFECYCLE  (Selenium special flow)
 * ============================================================
 *
 *  onTestFailure()
 *       │
 *       │  1. capture screenshot IMMEDIATELY (before browser state changes)
 *       │     TakesScreenshot.getScreenshotAs(BYTES)
 *       │
 *       │  2. store in pendingScreenshots map  { testId → screenshotBytes }
 *       │
 *       │  3. send  test_finished  event over WebSocket
 *       ▼
 *  Node.js API
 *       │
 *       │  4. INSERT test_case_execution → returns executionId
 *       │
 *       │  5. send ACK back over WebSocket
 *       │     { type: "ack", event: "test_finished", executionId, testId }
 *       ▼
 *  Selenium Reporter (onMessage)
 *       │
 *       │  6. receive ACK → look up pendingScreenshots[testId]
 *       │
 *       │  7. POST /api/screenshots/upload
 *       │     multipart: screenshot bytes + testCaseExecutionId
 *       ▼
 *  Node.js API → PostgreSQL (BYTEA storage)
 *
 *
 * ============================================================
 *  LIVE BROWSER VIEW  (separate channel — not /ws/ingest)
 * ============================================================
 *
 *  Playwright / Puppeteer  ──►  CDP Screencast  ──►  /ws/browser-stream
 *  Selenium                ──►  CDPScreencastManager
 *  Pytest                  ──►  LiveStreamManager (PIL screenshots)
 *
 *  Events on /ws/browser-stream:
 *    stream_started    ──►  { type, runId, testCaseExecutionId, timestamp }
 *    screencast_frame  ──►  { type, runId, frameData (base64 JPEG), url, metadata }
 *    stream_stopped    ──►  { type, runId, timestamp }
 *
 *
 * ============================================================
 *  AUTH FLOW  (before any WebSocket connection)
 * ============================================================
 *
 *  Reporter (all 4 frameworks)
 *       │
 *       │  POST /auth/validate-key
 *       │  { apiKey, appKey, runnerType }
 *       ▼
 *  Node.js API
 *       │
 *       ├── FAIL  ──►  reporter logs warning, tests run without QOP
 *       │
 *       └── PASS  ──►  returns:
 *                        wsUrl
 *                        sessionToken  (JWT, 1 hour)
 *                        projectKey
 *                        applicationId  (auto-created if new)
 *                               │
 *                               ▼
 *                    ws/ingest?sessionToken=...&appKey=...&runnerType=...
 *
 * ============================================================
 */
