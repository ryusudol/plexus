package paths

import "encoding/json"

func jsonUnmarshal(b []byte, dest any) error { return json.Unmarshal(b, dest) }
func jsonMarshal(v any) ([]byte, error)      { return json.Marshal(v) }
func jsonMarshalIndent(v any) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}
