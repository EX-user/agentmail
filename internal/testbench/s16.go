package testbench

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// S16 — 心跳面端到端（boss 排故令 2026-09-29 的台架钉子）：
//   - 事故：前端从未见 working——hb("working") 从未接线 + 20s keepalive
//     硬编码 "waiting"，把唤醒中的 arming/working 覆写回 waiting。
//   - 修复后契约：keepalive 携带板面当前态（CurrentState），working 在
//     唤醒内分钟 tick 上报，全程无 waiting 混入唤醒区间。
//
// 本场景让真 worker 对着捕获心跳的假邮件服务跑一次长唤醒（假 CLI 睡
// 65s，保证跨过 20s keepalive 两拍+1min working tick），断言上报序列：
//   1. 白名单五态纪律（waiting/working/compact/error/arming）；
//   2. arming → working → waiting 顺序成立，working 至少一拍（boss 面）；
//   3. 首拍 arming 到首拍 working 之间【零 waiting】——旧 keepalive 的
//      waiting 混入正是事故指纹，此处零容忍；
//   4. keepalive detail 的拍子里，状态必须是板面实况（arming/working），
//      不得出现硬编码 waiting。

type s16heartbeat struct{}

func (s16heartbeat) Name() string { return "s16-heartbeat-face" }
func (s16heartbeat) Desc() string {
	return "S16 心跳面端到端：keepalive 携带板面实况，唤醒区间零 waiting 混入，working 必现"
}
func (s16heartbeat) Timeout() time.Duration { return 3 * time.Minute }

type hbBeat struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
	TS     int64  `json:"ts"`
}

type hbCapture struct {
	mu    sync.Mutex
	beats []hbBeat
}

func (c *hbCapture) add(b hbBeat) {
	c.mu.Lock()
	c.beats = append(c.beats, b)
	c.mu.Unlock()
}

func (c *hbCapture) snapshot() []hbBeat {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]hbBeat, len(c.beats))
	copy(out, c.beats)
	return out
}

func (s s16heartbeat) Run(ctx context.Context, env *Env) Result {
	res := Result{Scenario: s.Name(), OK: true, StartedAt: time.Now()}
	defer func() { res.Duration = time.Since(res.StartedAt) }()

	if env.WorkerBin == "" {
		res.add("worker_bin_configured", false, "env.WorkerBin is empty")
		return res
	}
	root := env.Root()
	if err := ensureBenchFaces(root); err != nil {
		res.add("bench_faces", false, "%v", err)
		return res
	}

	// --- fixture: inbox + heartbeat 捕获（心跳面是本场景的被测物） ---
	cap := &hbCapture{}
	mails := []MailSummary{{
		ID: "01FIXTUREHB000000000000000X", From: "actor@fixture.test",
		Subject: "心跳面长唤醒演练", Preview: "S16：慢任务 65 秒，观测 keepalive 与 working 面。",
		Unread: true, ReceivedAt: time.Now().Unix(),
	}}
	srv, srvURL := newHeartbeatFixtureServer(mails, cap)
	defer srv.Close()

	// --- fake CLI：睡 65s 后交 JSON——长过两拍 keepalive+一拍 working tick ---
	binDir := filepath.Join(env.RunDir, "fakebin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		res.add("fake_cli", false, "%v", err)
		return res
	}
	slow := `#!/bin/bash
sleep 65
printf '{"type":"thread.started","thread_id":"s16fake"}\n{"session_id":"s16fake"}\n'
`
	if err := os.WriteFile(filepath.Join(binDir, "opencode"), []byte(slow), 0o755); err != nil {
		res.add("fake_cli", false, "%v", err)
		return res
	}

	workdir := filepath.Join(env.RunDir, "workdir")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		res.add("workdir", false, "%v", err)
		return res
	}
	cfgPath := filepath.Join(env.RunDir, "worker-s16.json")
	cfg := fmt.Sprintf(`{
  "server": %q, "address": "watched@fixture.test", "password": "x",
  "cli": "opencode", "workdir": %q,
  "poll_interval_sec": 1, "timeout_sec": 90
}`, srvURL, workdir)
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o644); err != nil {
		res.add("config", false, "%v", err)
		return res
	}

	cmd := exec.Command(env.WorkerBin, "-config", cfgPath)
	cmd.Env = WhitelistEnv(root,
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"TESTBENCH_MOCK=1",
	)
	cmd.Dir = workdir
	var wout strings.Builder
	cmd.Stdout, cmd.Stderr = &wout, &wout
	_ = env.TL.Add("note", "worker spawned (s16 heartbeat-face)", map[string]any{"bin": env.WorkerBin})
	if err := cmd.Start(); err != nil {
		res.add("spawn", false, "%v", err)
		return res
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()

	// --- 等 waiting 收尾拍（"last ok"），最长 110s；随见随杀防重醒 ---
	deadline := time.Now().Add(110 * time.Second)
	var final []hbBeat
	sawLast := false
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			res.add("budget", false, "scenario budget hit")
			return res
		}
		for _, b := range cap.snapshot() {
			if b.State == "waiting" && strings.HasPrefix(b.Detail, "last ok") {
				sawLast = true
			}
		}
		if sawLast {
			time.Sleep(300 * time.Millisecond) // 让收尾拍写完
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	final = cap.snapshot()
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()

	if len(final) == 0 {
		res.add("beats_captured", false, "no heartbeat beats reached the fixture (worker log: %s)", truncate(wout.String(), 300))
		return res
	}
	res.add("beats_captured", true, "%d beats", len(final))

	// --- 断言一：白名单五态纪律 ---
	okWL := true
	for _, b := range final {
		switch b.State {
		case "waiting", "working", "compact", "error", "arming":
		default:
			okWL = false
		}
	}
	res.add("state_whitelist", okWL, "every uploaded state must be one of the five faces")

	// --- 断言二：序列顺序 arming → working → waiting 收尾 ---
	firstArming, firstWorking, lastWaiting := -1, -1, -1
	for i, b := range final {
		switch {
		case b.State == "arming" && firstArming < 0:
			firstArming = i
		case b.State == "working" && firstWorking < 0:
			firstWorking = i
		case b.State == "waiting":
			lastWaiting = i
		}
	}
	seqOK := firstArming >= 0 && firstWorking > firstArming && lastWaiting > firstWorking
	res.add("face_sequence", seqOK, "arming(%d) < working(%d) < waiting(%d) required; got %d beats",
		firstArming, firstWorking, lastWaiting, len(final))

	// --- 断言三：唤醒区间零 waiting（事故指纹，零容忍） ---
	noWait := true
	for i := firstArming; firstArming >= 0 && i < firstWorking; i++ {
		if final[i].State == "waiting" {
			noWait = false
		}
	}
	res.add("no_waiting_midwake", noWait, "the old hardcoded-keepalive fingerprint (waiting between arming and working) must stay absent")

	// --- 断言四：keepalive 拍携带板面实况，不得硬编码 waiting ---
	hbKept := 0
	hbBad := 0
	for _, b := range final {
		if b.Detail != "keepalive" {
			continue
		}
		hbKept++
		if b.State != "arming" && b.State != "working" {
			hbBad++
		}
	}
	res.add("keepalive_carries_board", hbKept > 0 && hbBad == 0,
		"%d keepalive beats, %d carrying a non-board face (hardcoded waiting dies here)", hbKept, hbBad)

	if !(okWL && seqOK && noWait && hbKept > 0 && hbBad == 0) {
		res.OK = false
		dump, _ := json.Marshal(final)
		_ = env.TL.Add("evidence", "s16 beat sequence", map[string]any{"beats": truncate(string(dump), 600)})
	}
	return res
}

// newHeartbeatFixtureServer：inbox 面 + 心跳捕获端点（本场景专用）。
func newHeartbeatFixtureServer(mails []MailSummary, cap *hbCapture) (*http.Server, string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/inbox", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"messages": mails, "count": len(mails), "total_count": len(mails), "unread_count": len(mails),
		})
	})
	mux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"inbox_total": len(mails), "unread": len(mails), "sent_total": 0})
	})
	mux.HandleFunc("/api/subs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"subordinates": nil, "superiors": nil})
	})
	mux.HandleFunc("/api/worker/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		var b hbBeat
		_ = json.NewDecoder(r.Body).Decode(&b)
		cap.add(b)
		w.WriteHeader(http.StatusOK)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return &http.Server{Addr: "127.0.0.1:0", Handler: http.NotFoundHandler()}, ""
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return srv, "http://" + ln.Addr().String()
}

func init() { register(s16heartbeat{}) }
