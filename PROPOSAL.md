# implloop — 自動實作迴圈 pipeline 提案

> Draft v1（2026-07-30）。基於三條調查線：GitHub 上星星最多的 autonomous coding agent
> 專案架構（docs/research-survey.md）、驗證迴圈的實證研究（docs/research-verification.md）、
> 以及兩個已在實務驗證的前作——testgen（單元測試產生迴圈）與 prloop（PR 審查 pipeline）——
> 的設計哲學。

## 1. 定位

給定一個任務規格（M1：本地 task 檔；M4：Azure DevOps work item），由弱勢自架模型
（Qwen3-coder 27B 級）在目標 repo 實作出通過驗證的變更，產出一條乾淨的 git branch 供人開 PR。

控制流 100% TypeScript。LLM 只做三件事：規劃、寫碼、審查；驗證權（編譯、測試、
diff 檢查、git）永遠在 pipeline。這與前作相同，且是實證上正確的一邊：對 ~30B 開源模型，
結構化 pipeline 勝過同一顆模型自由 agentic 跑（Kimi-Dev：pipeline 60.4% vs agentic
48.6%；Agentless 50.8% Verified at $0.70/instance；SWE-agent ablation 顯示 scaffold 對
非 frontier 模型值 +64% relative）。

## 2. 痛點 → 對策

| 痛點 | 對策 | 依據 |
| --- | --- | --- |
| 弱模型一次吃整個 feature 會漏步驟、寫出無法收斂的大改動 | Plan gate：唯讀 planner 先拆成小而可獨立驗證的步驟（JSON schema），一步一個 fresh session 實作 | Self-planning +25.4% relative Pass@1；Laban et al. 多輪拆散需求 −39%；aider architect +2~10 pts（弱 executor 受益最大）；Spec Kit / Ralph「one item per loop」 |
| 長 session context rot，越跑越歪 | Fresh session per 步驟；跨步驟狀態只存在 artifacts（plan.json、feedback、git），不存在對話 | Context Rot（18 模型全部隨長度衰退）；Cline 連 context 摘要都只信 frontier 模型；Roo Boomerang「context poisoning」；CodeMonkeys：加深 serial 救不了卡住的軌跡，只有 fresh restart 有用 |
| 模型自述「做完了」不可信 | done = shell exit code：build/test 由 script 實際執行；模型永遠不能自己宣告通過 | goose retry.checks；testgen 原則 2（驗證權不外包）；Devika 之死（無驗證 gate 的 planner→coder demo well, dies in practice） |
| 迭代迴圈會誘發作弊（硬編碼期望值、改測試、skip） | Test-first + 測試檔結構性保護：先寫失敗測試 → pipeline 確認 fail-to-pass → commit → 之後任何 diff 碰到測試路徑直接 reject（git diff 檢查，不是 prompt 約定）；另設 BLOCKED 逃生口 | Claude 3.7 system card（多次失敗後開始 special-casing）；ImpossibleBench：測試唯讀 → 作弊趨近零；逃生口把 GPT-5 作弊 54%→9%；TGen：test-first 對弱模型加分最多（+9~13%） |
| 失敗報告餵回去沒有用、或越餵越糟 | 確定性 feedback schema：只餵第一組錯誤 + file:line + 局部程式碼，錯誤敘述放最前；絕不倒整份 log | RustAssistant：格式從 10.74% 修到 73.70%，一次修一組錯誤（去掉分組 73.6%→35.7%）；FeedbackEval：raw compiler dump 49.2% 還不如模板訊息；Olausson：弱模型自我診斷無增益 |
| 不收斂：同樣的錯誤修到天荒地老 | 每步驟修復上限 3 次 + 失敗簽章（gate＋正規化錯誤）重複即停損；停損時 salvage——branch 與已通過的 commits 保留，絕不丟掉部分成果 | 修復增益 76–95% 集中在前 2 輪；aider max_reflections=3；SWE-agent budget 用盡 auto-submit 現有 diff；OpenHands StuckDetector |
| 模型碰 git 會闖禍 | git 主權在 pipeline：preflight 要求 clean tree、自動開 branch、每個綠燈步驟 commit、違規或停損 reset --hard 回上一個綠燈 commit | aider auto-commit（git 即 undo）；OpenHands #9999（agent commit+push 闖禍）；Cline shadow checkpoints |
| 自我審查有 self-preference bias | Review gate 用不同 model family、單回合、唯讀、必須實際讀檔（tool calls=0 即 fail-closed）、發現必須附引文 | Greptile cross-model recall 53.7%→62.0%；NeurIPS 2024 self-preference 因果證據；EMNLP 2025（挑戰即翻供，故不許 implementer 與 reviewer 對話）；testgen must-read guard 實測擋過假判決 |

## 3. 各專案取用了什麼

- **前作 testgen / prloop（皆已實戰）**：單一確定性 orchestrator、驗證權不外包、
  injection over discovery、state in artifacts、fail-closed parse、startup guard（agent
  權限開機即 assert）、AgentRunner adapter、artifacts 全落盤。骨架直接沿用。
- **Spec Kit（124.5k★）**：spec → plan → tasks 的階段化 artifact；步驟必須「小、
  檔案不重疊、依賴排序、可獨立驗證」；`NEEDS CLARIFICATION` 標記變成可 grep 的確定性
  gate（規格不清就停下來問人，不猜）。同時記取其教訓：儀式與任務大小成比例
  （小任務被實測出 ~10× overhead），所以 plan schema 輕量、單檔。
- **Ralph Wiggum loop**：fresh context per iteration、進度只活在檔案系統與 git、
  one item per loop、tests as backpressure。其失敗模式（placeholder 實作、提前銷項、
  弱化測試）由本工具的確定性 gate 接手，而不是靠 prompt 大寫喊話。
- **aider（47.8k★）**：git auto-commit 即 checkpoint、修復迴圈硬上限 3、
  lint/test 失敗原文餵回；weak-model 證據鏈（Qwen3-32B whole > diff、architect/editor
  拆分 42.1%→73.6%）→ 步驟小到 writer 每次只動少數檔案，避免大 diff。
- **SWE-agent（20k★）**：唯一有完整 ablation 的介面研究——擋下第一個壞編輯、
  觀察摘要化、預算用盡 salvage 現有 diff。其 $ 上限換成自架環境的 session 數上限。
- **OpenHands（82.5k★）**：StuckDetector 的確定性停損模式；「驗證 = 多次嘗試＋
  外部過濾，不是更長的 episode」；32B 級模型可以當可靠的 judge（M3 的依據）。
- **Cline（65.2k★）**：warn-then-kill 兩段停損梯度；Plan/Act 結構性分離（planner
  唯讀不是靠自律）。
- **goose（51.9k★）**：retry.checks——完成條件 = shell exit code，由 orchestrator 持有。
- **Agentless / Kimi-Dev / CodeMonkeys**：對開源模型，pipeline > agentic 的直接數據；
  regression + reproduction test 過濾是選 patch 最大增益來源（M3 best-of-N 的依據）。
- **Anthropic / OpenAI 官方最佳實務**：failing tests 先行並 commit、明示不可改測試、
  fresh-context 驗證者。hook（機器強制）> 指南（模型可能略過）→ 本工具把所有契約
  做成 gate 與 guard。

## 4. 架構總覽（控制流）

```
implloop <task.md>            （於目標 repo 根執行；bin/implloop wrapper）
        │
        ▼
loop.ts ─── 參數驗證 / startup guard（agent 權限 assert）/ git preflight：
        │   clean tree + baseline 測試通過 → 開 branch implloop/<slug> / runs/ 建立
        ▼
orchestrator.ts  ←── 唯一 loop controller（確定性）
        │
        │  Phase P・Plan（planner，唯讀，fresh session）
        │    task → JSON：steps[]（小、可驗證、依賴排序）+ test_plan + clarifications[]
        │    fail-closed parse；clarifications 非空 → exit 4（規格不清，找人，不猜）
        │
        │  Phase T・Test-first（writer，fresh session）〔IL_TEST_FIRST=1 預設開〕
        │    依 test_plan 寫「會失敗的」驗收測試
        │    gate：測試檔可編譯 + 新測試確實 FAIL（fail-to-pass 由 script 驗證）
        │    → git commit → 自此測試路徑凍結（保護清單）
        │
        │  Phase I・Implement（每個 plan 步驟一個 fresh session）
        │    writer 實作當前步驟 → 確定性檢查鏈：
        │      1) protect gate：git diff 碰到凍結測試路徑/保護 glob → reset 該步驟，違規計次
        │      2) build gate：IL_BUILD_CMD（偵測 maven/gradle/npm，可覆蓋）
        │      3) test gate：IL_TEST_CMD 全綠才過
        │    失敗 → 餵回第一組錯誤（schema 化），同一步驟最多重試 IL_STEP_RETRIES=3
        │    失敗簽章連續重複 IL_STUCK_REPEATS=2 次 → 停損（salvage：reset 回上個
        │    綠燈 commit，branch 與已完成步驟保留，exit 2）
        │    步驟全綠 → git commit（checkpoint）→ 下一步驟
        │    writer 回報 BLOCKED（規格/測試矛盾逃生口）→ exit 4，不硬寫
        │
        │  Phase R・Review（reviewer，唯讀、不同 model family、單回合，fresh session）
        │    diff + 任務規格 → JSON 判決：per-requirement verdict + blockers[]
        │    tool calls = 0 → fail-closed REJECT；blockers 餵回 Phase I 再修
        │    （共用 session 總預算 IL_MAX_SESSIONS）
        ▼
輸出 ─── branch（每綠燈步驟一個 commit）+ runs/<repo>/<ts>/ 全 artifacts + summary
退出碼：0 全過｜2 停損（salvage 保留）｜3 pipeline 自身故障｜4 規格不清/BLOCKED｜1 致命
```

## 5. 四個核心設計

### 5.1 Test-first 與測試檔結構性保護（防 gate gaming）

迭代迴圈正是誘發作弊的環境（Claude 3.7 system card：special-casing 多發生在「多次失敗
之後」）。對策不是 prompt（METR 實測「please do not reward hack」反而使作弊上升），
而是結構：

1. Phase T 先寫驗收測試，pipeline 實際執行驗證其 fail-to-pass（新測試必須失敗；
   既有測試在 preflight baseline 已確認通過），然後 commit。
2. 自此測試路徑進保護清單。Phase I 每輪 `git diff --name-only` 一碰到保護路徑即
   reset 該輪、記違規——這是 exit-code 等級的擋法，ImpossibleBench 實測可把作弊壓到趨近零。
3. 搭配 hack-marker 掃描（新增的 skip/xfail/@Disabled、`sys.exit(0)`、CI 設定改動），
   命中即同保護路徑處理。
4. 逃生口：writer 可正式回報 BLOCKED（規格與測試矛盾、缺外部資訊）→ pipeline exit 4
   交還人類。實測把作弊率 54%→9%：堵死所有路會逼弱模型作弊，要留一扇誠實的門。

### 5.2 一步驟一 session，狀態在 artifacts（收斂的前提）

- Planner 產出的步驟必須「小、可獨立驗證、依賴排序」（Spec Kit 任務規格 + CodePlan：
  跨檔依賴排序是 orchestrator 的工作）。
- 每步驟開全新 writer session：上一步的知識只透過（a）repo 現況（git）、（b）plan.json、
  （c）失敗報告三個 artifact 傳遞。長對話的 context rot 與 hallucination 累積被結構性
  切斷（Ralph / Boomerang / CodeMonkeys 三方收斂的同一結論）。
- 弱模型的 instruction-following 隨指令數指數衰退（IFScale），所以每個 prompt 只含
  當前步驟的目標與少數硬規則，不塞整份規格。

### 5.3 確定性 feedback 與雙層停損

失敗報告是 pipeline 組裝的，不是 log 轉印（RustAssistant 的 ablation：同樣的錯誤，
格式從 10.74% 修到 73.70%）：

```
[gate 名稱] 第一組錯誤（一次只修一組）
錯誤敘述（放最前）
file:line + 該檔局部片段
（測試失敗時）失敗測試名 + expected vs actual
```

停損兩層：(1) 每步驟修復 ≤3 次（增益 76–95% 集中在前兩輪，之後是燒 token）；
(2) 失敗簽章 hash（gate + 正規化錯誤）連續重複 2 次 = 沒有新資訊，立即停損。
停損永遠 salvage：已通過步驟的 commits 與 branch 保留，附最後失敗報告退出——
絕不丟棄部分成果（SWE-agent auto-submit 的教訓）。

### 5.4 Git 主權在 pipeline

writer 沒有 bash，碰不到 git。pipeline：preflight 檢查 clean tree、跑 baseline 測試、
開 `implloop/<slug>` branch；每個通過全部 gate 的步驟一個 commit（即 checkpoint）；
違規或停損 `reset --hard` 回上一個綠燈 commit。人類拿到的是一條每個 commit 都綠的
branch，squash 開 PR 即可。

## 6. 角色與權限矩陣

| tool | impl-planner | impl-writer | impl-reviewer | 理由 |
| --- | --- | --- | --- | --- |
| read/glob/grep | [OK] | [OK] | [OK] | 都要讀碼 |
| write/edit | [FAIL] | [OK] | [FAIL] | 唯讀角色能寫檔就會「順手修好」，污染 signal |
| bash | [FAIL] | [FAIL] | [FAIL] | 驗證權與 git 主權在 loop |
| webfetch | [FAIL] | [FAIL] | [FAIL] | 縮小面 |

startup guard 開機 assert 全部矩陣（沿用 testgen 的 machine-assert 手法）。
模型建議：planner 與 writer 可同顆（單卡免 reload thrash）；reviewer 盡量跨 family
（Greptile：cross-model recall 明顯較高）。單卡放不下時，must-read guard 是底線防護。

## 7. 已否決方案（防止重新提案）

- **LLM 自由 agentic 跑（模型自己決定下一步/重試/停止）**：對 ~30B 模型，同一顆模型
  pipeline 化直接贏 agentic 跑（Kimi-Dev 60.4% vs 48.6%）；且 100-turn 探索在自架
  硬體上貴到不可行。frontier 模型的 mini-swe-agent 結論不適用於本模型級距。
- **一次把整個 feature 丟給 writer**：Self-planning/CodePlan/多輪拆散 −39% 證據俱在；
  弱模型漏步驟是主要死因。
- **靠 prompt 禁止作弊**：METR 實測會反效果。用結構（測試唯讀 + diff 檢查 + 逃生口）。
- **held-out 測試防作弊**：EvilGenie 實測增益極小，不如 LLM-judge diff review + 結構性
  保護。M3 再評估 mutation testing。
- **長 session + context 摘要**：摘要品質本身依賴強模型（Cline 明文只給 frontier 模型
  摘要權）。fresh session + 檔案狀態較穩。
- **repo 全文/RAG 餵 context**：prloop 已否決 RAG（commit 即過期、相似≠相依）；
  SWE-agent ablation：整檔比 100 行窗還差。M2 做 ranked repo map（aider 式、固定預算）。
- **writer 自跑測試（給 bash）**：testgen 原則 2 的老理由不變——能自跑 = 能自述通過 =
  gate 被架空；且 OpenHands #9999 示範了 agent 碰版控的後果。
- **binary 零缺陷 review gate**：LLM judge 幾乎不回空 issues（testgen/prloop 兩度驗證），
  會震盪；用 blockers/advisories 分級 + 單回合。
- **每次 tool use 做 shadow checkpoint（Cline 式）**：本架構 writer session 是黑盒、
  以步驟為單位驗證，step-level git commit 已提供等值 rollback，粒度更細只是複雜度。

## 8. 專案結構（與前作同哲學）

```
implloop/
  loop.ts                 # 入口：驗證、startup guard、git preflight、runs/ 建立
  orchestrator.ts         # 唯一 loop controller（Plan → Test-first → Implement → Review）
  config.ts               # SSOT：全部參數，IL_* env 可覆蓋
  prompts.ts              # planner/writer(test|impl|fix)/reviewer 模板（注入，不靠 discovery）
  gates/
    plan.ts               #   plan JSON fail-closed parse + 步驟結構驗證 + clarification gate
    build.ts              #   build/test 指令偵測（maven/gradle/npm）與執行、報告組裝
    protect.ts            #   保護路徑 diff 檢查 + hack-marker 掃描（零 LLM）
    review.ts             #   review verdict fail-closed parse + must-read enforcement
  libs/
    git.ts                #   preflight / branch / commit / reset / diff（git 主權層）
    feedback.ts           #   失敗報告 schema 組裝（第一組錯誤 + 局部化）
    stuck.ts              #   失敗簽章 hash 與停損判定
    guard.ts log.ts shell.ts types.ts version.ts
  runners/
    runner.ts opencode.ts #   AgentRunner adapter（沿用 testgen 驗證過的 runner）
  .opencode/agent/        # impl-planner / impl-writer / impl-reviewer（npm run setup 裝到 global）
  scripts/                # doctor.ts（preflight+smoke）/ selftest.ts / setup.ts
  runs/                   # artifacts：每 run 每 phase 全落盤
```

## 9. 分階段交付

- **M1（可用骨架）**：本地 task 檔 → Plan → Test-first → Implement loop → Review →
  綠燈 branch。含全部確定性 gate、停損、salvage、doctor、selftest。
- **M2（context 工程）**：ranked repo map 注入（aider 式固定預算）、失敗報告 ±50 行
  局部化、per-language profile（lint gate 進檢查鏈）。
- **M3（test-time scaling）**：同步驟 best-of-N fresh 重試（溫度多樣性）、以測試結果
  選 patch；評估 mutation testing 驗測試品質。
- **M4（ADO 整合）**：work item → AC 取用（沿用 prloop ado/ 層）、自動開 PR、
  review verdict 對 AC 的 coverage matrix。
- **M5（回饋學習）**：人類 reject 記錄、per-repo 慣例注入（沿用 prloop 的 dismissal
  learning 模式）。

每個 milestone 都端對端可跑（在真 repo 產出綠燈 branch），不做水平分層。

## 10. 如何評估（避免「感覺有變好」）

- **離線**：挑 10–20 個歷史小 feature/bugfix（已知正解 diff）當 golden set；指標：
  端對端成功率、停損率、平均 session 數、作弊攔截數（protect gate 觸發）。
- **線上**：branch 被人類採用率（squash merge 率）、review blockers 的人工同意率、
  exit 4（誠實舉手）與 exit 2（停損）的比例——exit 4 偏高代表 task 檔寫太差，
  不是工具壞。
- 校準預期：Qwen3-Coder-30B 級在 SWE-bench Verified 約 50%；內部 task 比 SWE-bench
  乾淨（有人寫規格），目標「小型明確任務 ≥60% 端對端綠燈、其餘誠實停損」比追求
  全自動更實際。

## 11. 主要參考

完整清單與數據見 docs/research-survey.md、docs/research-verification.md。
關鍵：SWE-agent ACI ablation（NeurIPS 2024）· Agentless（FSE 2025）· Kimi-Dev
（arXiv 2509.23045）· CodeMonkeys（arXiv 2501.14723）· TGen TDD（ASE 2024）·
ImpossibleBench（arXiv 2510.20270）· METR reward hacking（2025-06）· RustAssistant
（ICSE 2025）· FeedbackEval（arXiv 2504.06939）· 修復收斂（arXiv 2604.10508）·
Self-planning（TOSEM 2024）· Laban et al.（arXiv 2505.06120）· Context Rot（Chroma）·
Greptile model inversion · Spec Kit · Ralph Wiggum loop（ghuntley.com/ralph）·
aider benchmarks（edit formats / architect / Qwen3）· OpenHands StuckDetector ·
goose retry.checks · Cline checkpoints/loop-detection。
