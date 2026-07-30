# implloop — 自動實作迴圈 pipeline

給它一個任務規格，implloop 用弱勢自架模型（Qwen3-coder 27B 級）在目標 repo 實作出
通過驗證的變更，產出一條「每個 commit 都綠」的 git branch 供人開 PR。

控制流 100% TypeScript：Plan → Test-first → Implement → Review 四個 phase，每個
gate（build、test、diff 保護、審查解析）都由 pipeline 確定性執行。LLM 只做規劃、
寫碼、審查三件事，永遠拿不到迴圈的控制權，也碰不到 git。

設計依據與研究基礎：[PROPOSAL.md](./PROPOSAL.md)（含 docs/ 兩份高星專案與實證研究
調查）。與同家族工具 prloop（PR 審查）、testgen（單元測試產生）共用同一套骨架哲學。

```
implloop <task.md>        （於目標 repo 根執行）
   │
   ├─ preflight   clean tree + baseline 測試綠 → 開 branch implloop/<slug>-<date>
   ├─ Phase P     planner（唯讀）把 task 拆成 ≤8 個小步驟；規格不清 → exit 4 找人
   ├─ Phase T     先寫「會失敗的」驗收測試（fail-to-pass 由 script 驗證）→ commit 後凍結
   ├─ Phase I     一步驟一個全新 writer session → protect / build / test gate
   │              全綠才 commit checkpoint；同一失敗重複出現即停損（salvage）
   └─ Phase R     跨模型唯讀 reviewer 單回合審查 diff；blockers 回修
```

## 防作弊是結構性的，不是用嘴巴講

迭代迴圈正是誘發模型作弊的環境（多次失敗後開始硬編碼期望值、改測試）。implloop 的
對策全部在 exit-code 層：

- Phase T 凍結的驗收測試檔，之後任何 diff 碰到就整輪還原（`git diff` 檢查）。
- 新增行掃 hack markers（skip/@Disabled/xfail/exit(0)），命中同樣還原。
- 誠實的門：writer 可回報 `BLOCKED: <理由>`（規格與測試矛盾、缺外部資訊），
  pipeline 以 exit 4 交還人類——堵死所有路只會逼弱模型作弊。

## 前置需求

- Node.js 20+；opencode CLI（版本需支援 `--format json`）；LLM provider 存取權。
- ripgrep（`rg`）。opencode 的 glob 與 grep 都由它實作，planner 與 writer 探索 repo 時
  必用；缺了會讓兩個工具一律回 `[error]`。見 Troubleshooting 最後一項。
- 目標 repo 是 git repo，且有可跑的測試指令（自動偵測 maven / gradle / npm test /
  pytest，或以 `IL_BUILD_CMD` / `IL_TEST_CMD` 指定）。

## 安裝

```bash
git clone <repo> implloop && cd implloop
npm install
npm run setup      # 安裝 impl-planner / impl-writer / impl-reviewer 到 ~/.config/opencode/
npm run check      # typecheck + 72 個離線測試
```

選用：把 wrapper 加入 PATH，之後在任何目錄都能用 `implloop`。

```bash
echo 'export PATH="$PATH:'$(pwd)'/bin"' >> ~/.zshrc && source ~/.zshrc
```

模型設定：編輯 `~/.config/opencode/agent/impl-*.md` 的 `model:` 欄位，或用
`IL_PLANNER_MODEL` / `IL_WRITER_MODEL` / `IL_REVIEWER_MODEL` 覆蓋（`IL_MODEL` 一次
設定 planner+writer）。reviewer 盡量用不同 model family——cross-model 審查的 recall
明顯高於自我審查；單卡放不下兩顆時，must-read guard（tool calls=0 即 REJECT）是
底線防護。

## 第一次執行

```bash
cd <目標 repo 根目錄>
$EDITOR tasks/my-feature.md          # 寫任務規格：要做什麼、驗收條件是什麼
implloop doctor tasks/my-feature.md --smoke   # preflight + 實測 provider 一次
implloop tasks/my-feature.md
```

task 檔就是一份 markdown：描述需求與驗收條件，寫得越可驗證，Phase T 的測試越有效。
起手挑小而明確的任務（一個 endpoint、一個 bugfix）。

退出碼：`0` 全過（branch 可直接開 PR）｜`2` 停損（已完成步驟保留在 branch 上）｜
`4` 規格不清或 BLOCKED（需要人回答）｜`1` 致命錯誤。

每輪產物寫入 `<clone>/runs/<repo 名>/<時間戳>/`：每個 phase 的 prompt、模型原文、
build log、失敗報告、review 判決。結果怪的時候從這裡查起。

## 參數

全部為環境變數、全部選填，詳見 `.env.example`。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `IL_MODEL` / `IL_PLANNER_MODEL` / `IL_WRITER_MODEL` / `IL_REVIEWER_MODEL` | agent .md 的 model | `provider/model` 格式覆蓋 |
| `IL_MAX_SESSIONS` | 20 | 整個 run 的 agent session 總預算 |
| `IL_STEP_RETRIES` | 3 | 每步驟修復嘗試上限（實證：增益集中在前 2 輪） |
| `IL_STUCK_REPEATS` | 2 | 同一失敗簽章連續重複幾次即停損 |
| `IL_MAX_STEPS` | 8 | 計畫步驟上限（強迫任務切小） |
| `IL_TEST_FIRST` | 1 | 0 = 跳過 Phase T（不建議：防作弊主力） |
| `IL_BUILD_CMD` / `IL_TEST_CMD` | 自動偵測 | 建置/測試指令覆蓋 |
| `IL_PROTECT` | - | 額外保護 glob（逗號分隔） |
| `IL_REVIEW_ROUNDS` | 2 | review 修正回合上限 |
| `IL_SKIP_REVIEW` | - | 1 = 跳過 review gate |
| `IL_REVIEWER_MUST_READ` | 1 | 0 = 允許 reviewer 沒讀檔就給判決（不建議） |
| `IL_AGENT_TIMEOUT_MS` | 1500000 | 單 session 逾時（25 分鐘，dense 27B 實測值） |
| `IL_BRANCH_PREFIX` | implloop/ | run branch 前綴 |
| `IL_SKIP_BASELINE` | - | 1 = 跳過起點 baseline 測試（不建議） |

## Troubleshooting

先跑 `implloop doctor <task.md> --smoke`，多數問題會直接指出修法。

- **preflight 說 working tree 不乾淨。** implloop 需要乾淨起點才能安全 reset 失敗的
  迭代；先 commit 或 stash。
- **baseline 測試就紅了。** 起點是紅的，之後所有 gate 都無法歸因；先修好既有測試。
- **writer 有跑但沒寫檔。** 非互動模式 permission 被擋。在目標 repo 根放 project 級
  `opencode.json`：`{"permission": {"edit": "allow"}}`；最後手段 `IL_OC_SKIP_PERMS=1`
  （writer 的 bash/web 本來就關閉，風險有限）。
- **一直停在 fail-to-pass gate。** 新測試必須「可編譯、執行後失敗」。看
  `runs/.../tests-attempt-N/feedback.md`：常見原因是測試寫成無意義斷言（跑就過）、
  或 writer 順手把功能實作掉了。
- **protect gate 一直攔。** writer 想改測試或加 skip。看 feedback 內列的違規項；
  若測試真的與規格矛盾，正確路徑是 writer 回報 BLOCKED，人來改測試。
- **exit 4 很常見。** 這不是故障——代表 task 檔寫得太模糊（planner 提問）或規格
  自相矛盾（writer BLOCKED）。把 task 檔的驗收條件寫具體，成功率會直接上升。
- **看不到即時進度。** opencode 版本太舊，設 `IL_OPENCODE_JSON=0` 退回整段輸出。
- **trace 裡 glob 與 grep 一律 `[error]`。** 缺 ripgrep。opencode 的找法是 PATH 上的
  `rg`（Windows 為 `rg.exe`）→ 家目錄下的 `.cache/opencode/bin/`（Windows 也走這個
  XDG 路徑，即 `%USERPROFILE%\.cache\opencode\bin\rg.exe`）→ 從 GitHub Releases 下載。
  封閉網路第三步必失敗，所以要讓前兩步之一命中：裝套件（`winget install
  BurntSushi.ripgrep.MSVC` / `brew install ripgrep` / `apt install ripgrep`），或直接
  複製 VS Code 自帶的那份到上述 cache 目錄（在
  `<VS Code>\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe`）。
  驗證：`opencode debug rg files --glob "**/*" --limit 5`。

## Development

```bash
npm run check      # typecheck + selftest（離線，不碰模型/網路）
```

`scripts/selftest.ts` 是所有確定性 gate 的回歸網——動過 `gates/` 或 `libs/` 後必跑。
斷言直接對應 gate 要擋的失敗模式：捏造的計畫路徑、假 verdict、測試竄改、
log 傾倒式 feedback、不收斂的重試。

## Status

M1（可用骨架）完成：Plan → Test-first → Implement → Review 端對端，含全部確定性
gate、雙層停損、salvage、doctor、selftest。
後續：M2 context 工程（repo map 注入、±50 行局部化）、M3 best-of-N + 測試選 patch、
M4 ADO work item 整合、M5 回饋學習。見 PROPOSAL.md §9。

MIT.
