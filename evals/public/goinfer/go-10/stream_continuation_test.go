package tokenizer

import (
	"testing"
	"unicode/utf8"
)

// Run beside stream_test.go at the pinned head to reproduce the control boundary.
func TestStandaloneContinuationByteParity(t *testing.T) {
	tk, _, pieces := byteLevelStreamTokenizer()
	id := pieces[1]
	whole, err := tk.Decode([]int{id})
	if err != nil {
		t.Fatal(err)
	}
	stream := tk.NewStream()
	chunk, err := stream.Write(id)
	if err != nil {
		t.Fatal(err)
	}
	tail := stream.Flush()
	if chunk != "\x9f" || utf8.ValidString(chunk) || tail != "" || chunk+tail != whole {
		t.Fatalf("write %x, flush %x, whole-sequence Decode %x", chunk, tail, whole)
	}
}
