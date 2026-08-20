package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

type Case struct {
	ID               string `json:"id"`
	Question         string `json:"question"`
	GroundTruth      string `json:"ground_truth"`
	GoodAnswer       string `json:"good_answer"`
	GoodAnswerReword string `json:"good_answer_reworded"`
	BadAnswer        string `json:"bad_answer"`
}

type Fixtures struct {
	Cases []Case `json:"cases"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Println("usage: go run . <path-to.wasm> <path-to-fixtures.json>")
		os.Exit(1)
	}
	wasmPath, fixturesPath := os.Args[1], os.Args[2]

	wasmBytes, err := os.ReadFile(wasmPath)
	if err != nil {
		panic(err)
	}
	fixtureBytes, err := os.ReadFile(fixturesPath)
	if err != nil {
		panic(err)
	}
	var fixtures Fixtures
	if err := json.Unmarshal(fixtureBytes, &fixtures); err != nil {
		panic(err)
	}

	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)

	compiled, err := rt.CompileModule(ctx, wasmBytes)
	if err != nil {
		panic(fmt.Sprintf("module failed to compile: %v", err))
	}
	importCount := len(compiled.ImportedFunctions())
	fmt.Printf("=== Binary checks ===\n  size: %d bytes\n  imported functions: %d (must be 0)\n\n", len(wasmBytes), importCount)

	mod, err := rt.InstantiateModule(ctx, compiled, wazero.NewModuleConfig())
	if err != nil {
		panic(fmt.Sprintf("module failed to load: %v", err))
	}
	defer mod.Close(ctx)

	mem := mod.Memory()
	if mem == nil {
		panic("module exports no linear memory")
	}
	alloc := mod.ExportedFunction("alloc")
	rankAnswer := mod.ExportedFunction("rank_answer")
	if alloc == nil || rankAnswer == nil {
		panic("module is missing a required export: alloc or rank_answer")
	}

	writeStr := func(s string) (ptr, length uint32) {
		if len(s) == 0 {
			return 0, 0
		}
		res, err := alloc.Call(ctx, uint64(len(s)))
		if err != nil {
			panic(fmt.Sprintf("alloc failed: %v", err))
		}
		p := uint32(res[0])
		if !mem.Write(p, []byte(s)) {
			panic("failed to write into module memory")
		}
		return p, uint32(len(s))
	}

	rank := func(question, groundTruth, answer string) float32 {
		qPtr, qLen := writeStr(question)
		gtPtr, gtLen := writeStr(groundTruth)
		maPtr, maLen := writeStr(answer)
		res, err := rankAnswer.Call(ctx,
			uint64(qPtr), uint64(qLen),
			uint64(gtPtr), uint64(gtLen),
			uint64(maPtr), uint64(maLen),
		)
		if err != nil {
			panic(fmt.Sprintf("rank_answer failed: %v", err))
		}
		return api.DecodeF32(res[0])
	}

	allPass := true
	fail := func(format string, args ...interface{}) {
		allPass = false
		fmt.Printf("  FAIL: "+format+"\n", args...)
	}

	// Stage-1-style structural checks, run globally, not per case.
	fmt.Println("=== Structural checks ===")
	empty := rank("q", "ground truth text", "")
	if empty != 0 {
		fail("empty answer scored %.4f, must be exactly 0", empty)
	} else {
		fmt.Println("  OK: empty answer -> 0")
	}
	blank := rank("q", "ground truth text", "   ")
	if blank != 0 {
		fail("whitespace-only answer scored %.4f, must be exactly 0", blank)
	} else {
		fmt.Println("  OK: whitespace-only answer -> 0")
	}

	fmt.Println("\n=== Fixture cases ===")
	var scores []float32
	for _, c := range fixtures.Cases {
		fmt.Printf("--- %s ---\n", c.ID)
		self := rank(c.Question, c.GroundTruth, c.GroundTruth)
		good := rank(c.Question, c.GroundTruth, c.GoodAnswer)
		bad := rank(c.Question, c.GroundTruth, c.BadAnswer)
		fmt.Printf("  self-match:  %.4f (must be >= 0.75)\n", self)
		fmt.Printf("  good_answer: %.4f\n", good)
		fmt.Printf("  bad_answer:  %.4f\n", bad)
		scores = append(scores, self, good, bad)

		if self < 0.75 {
			fail("%s: self-match %.4f < 0.75", c.ID, self)
		}
		if !(good > bad) {
			fail("%s: good_answer (%.4f) did not beat bad_answer (%.4f)", c.ID, good, bad)
		}

		if c.GoodAnswerReword != "" {
			reword := rank(c.Question, c.GroundTruth, c.GoodAnswerReword)
			fmt.Printf("  good_answer_reworded: %.4f\n", reword)
			scores = append(scores, reword)
			if !(reword > bad) {
				fail("%s: reworded good answer (%.4f) did not beat bad_answer (%.4f)", c.ID, reword, bad)
			}
		}
	}

	// Score spread check (mirrors Stage 2's "scores actually vary" bar).
	var min, max float32 = 1, 0
	for _, s := range scores {
		if s < min {
			min = s
		}
		if s > max {
			max = s
		}
	}
	fmt.Printf("\n=== Spread ===\n  min=%.4f max=%.4f range=%.4f\n", min, max, max-min)
	if max-min < 0.2 {
		fail("score spread %.4f looks too small (all scores near-identical)", max-min)
	}

	fmt.Println()
	if allPass {
		fmt.Println("ALL CHECKS PASSED")
	} else {
		fmt.Println("SOME CHECKS FAILED")
		os.Exit(1)
	}
}
