// Package protocol 是 WW3 插件契约的 Go 实现入口。
//
// 本包只导出**契约版本**，其余能力在各子包（jsonl / rpc / plugin / chat / …）。
//
// 版本策略：module major == IPC 协议版本。插件在 manifest.protocol 里声明
// {"min":1,"max":1}，与 Version 是同一个真值来源（W3-53）。
package protocol

// Version 是当前 IPC 协议版本（整数）。破坏性改动必须 +1 并升 module major。
const Version = 1
