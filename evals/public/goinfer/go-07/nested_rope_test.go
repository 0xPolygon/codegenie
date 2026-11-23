package decoder

import (
	"encoding/json"
	"testing"
)

func TestOracleNestedOlmo3RoPE(t *testing.T) {
	cfg := &Config{
		ModelType: "olmo3", VocabSize: 128, HiddenDim: 16, NumLayers: 4,
		NumHeads: 4, NumKVHeads: 4, IntermediateDim: 32, RMSNormEps: 1e-5,
		HiddenAct: "silu", SlidingWindow: 8,
		LayerTypes: []string{"sliding_attention", "sliding_attention", "sliding_attention", "full_attention"},
		RopeParameters: json.RawMessage(`{
			"full_attention": {"rope_type": "default", "rope_theta": 500000},
			"sliding_attention": {"rope_type": "default", "rope_theta": 10000}
		}`),
	}
	arch, _, err := resolveArchitecture(cfg)
	if err != nil {
		t.Fatalf("resolve nested Olmo 3 RoPE config: %v", err)
	}
	if arch.RoPEGlobalBase != 500000 {
		t.Fatalf("global RoPE base = %v, want 500000", arch.RoPEGlobalBase)
	}
}
