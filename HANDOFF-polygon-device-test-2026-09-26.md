# 実機テスト先の更新: Polygon PoS mainnet

2026-09-26、ユーザーは「実機テストはPolygonとして伝えておきたい」と指定した。**実機テスト先はPolygon PoS mainnet（chainId 137 / eip155:137）。** 35の通常予算OR注文専用本人承認、失効・改変・承認再利用の拒否、LINE主デモの要件は維持する。

着手時に[具体的な引継ぎメモ](/Users/shineikikkawa/dev/project/own/jpyc/jpyc-ec-platform/docs/business/events/ethtokyo/polygon-device-test-handoff-2026-09-26.md)を読む。35の設計一式に残るSepolia実機試験先の記述より、この指定を優先する。

確認時点では `apps/server/src/agent-bootstrap.ts` と `packages/evm/src/erc7710/engine.ts` が137を拒否する。Polygon用配備manifest、proxy implementation pin、Node agent経路の設定、EC側chainと署名の一致、MetaMaskの7702＋7715（MaxUint256＋Gate redeemer＋期限）の実受理まで確認が必要。

調査のPolygon fork成功と実機成功は区別する。新しい指示を記録したメモであり、Polygon統合完了の報告ではない。進行中のアプリコードはこのメモ作成では変更していない。
