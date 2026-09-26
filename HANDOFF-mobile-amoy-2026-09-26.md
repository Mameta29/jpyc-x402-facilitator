# ETHGlobal Tokyo 2026 Facilitator再開メモ

## 最新の再開地点（2026-09-26 22:00 JST）

- **Amoy公開配備・manifest・staging購入サービスの有効化まで完了。** ECの[公開配備結果](../ethtokyo-ec/docs/agent-commerce/AMOY-BOOTSTRAP-2026-09-26.md)と[有効化証跡](../ethtokyo-ec/docs/agent-commerce/evidence/amoy-staging-activation-2026-09-26.json)を参照。clone先ではEC repoの同じファイルを開く。
- 9取引確定、Gate `0x7ff8f1dDb0BD06D12a27F8FA1Dc8922F19d27754`、約10万test JPYCのsource所有LP、20pins/両token proxy/5quoteを照合。manifest SHA256 `9c76ef50f5d5e98a0ae551db73eef8e38f7ec4a621e44f523f608fe1fd36284e`。
- VPS `/etc/jpyc-agent-staging/amoy-manifest.json` とVercel Preview/stagingに同じmanifestを反映。EC source454a0e09、staging eb580739、Vercel dpl_EomQkhSEjvXJK8fGAjg2xJm4eMgF READY。Facilitator code8ccd520。signer/Facilitator/worker/chat/selectorの5サービスactive・再起動0、公開health200、未認証API401、worker HMAC要求200。
- Amoy deployerへの追加5＋5 test POLを確認し、配備後残高9.256690648019050365。別途mainnetにも5＋5 POLが届き、ユーザー明示依頼で実本番gas payer `0x8e820462744053dDB651C047C2d7A31549794f8C` へそれぞれ全額からガスを引いて補充済み。Amoy agent relayer `0x54DBc799C01d90c0E80D642F82455Ee3d8F69Dd2` とは別。初期入金・LP/配備・mainnet送金を繰り返さない。
- 次は**LINE/Telegramでの依頼→AIの初回設定リンク→本人MetaMask/World→予算→同じ会話での再開**。実機permission/本人登録/公開注文/購入は未確認。単独の診断URLから始めるよう要求しない。通常予算OR注文専用本人承認を維持する。

以下は初回引継ぎ時点の履歴。停止中/配備前の記述は上記で更新される。

記録日: 2026-09-26。実装branchは **`ETHGlobalTokyo2026`**。この記録追加前のHEADは `8ccd52049c01935a8f9487c7dffdd963bd516217`。

同じMacでの全体引継ぎは [EC worktreeの詳細](../ethtokyo-ec/docs/agent-commerce/HANDOFF-2026-09-26-mobile-amoy.md)。clone先ではEC repoの `docs/agent-commerce/HANDOFF-2026-09-26-mobile-amoy.md` を開く。Facilitatorの設定手順は [POLYGON](docs/agent-commerce/POLYGON.md)。

## 確定事項

- **Polygon Amoy testnet / 80002**。古い `HANDOFF-polygon-device-test-2026-09-26.md` のmainnet 137指定は撤回済み。通常予算 OR 登録本人の注文専用承認を維持し、期間予算超過も単回例外の対象とする。失効・改変・署名不正・replayは解除しない。
- LINE主デモ・Telegram試用、スマホ→MetaMaskを主導線にする。ECで既存POSの接続を流用済み。実機7702/7715はユーザーが後で確認する。
- 両repoで細かくコミットし、検証済み実装をstagingへ反映。EC側は提出文書を除外する専用promotion scriptを使う。EC branch全体をstagingへ直接pushしない。

## 完了済み・再実施しないこと

- 9/26 18:47 JST、AI `0x41f6b355e3fA65B797a7b1c2d503344c38ea0751` からユーザー承認済みのAmoy送金5件が確定。
- 購入者 `0x19E740eb9aB7373CF19Badb7a606f4C5c4e04C86`: 10,000 test JPYC・20 test USDC・0.05 test POL。
- agent relayer `0x54DBc799C01d90c0E80D642F82455Ee3d8F69Dd2`: 0.1 test POL。
- deployer `0x27588efDeB62F2968c85f2B6d87488B08d7117b7`: 0.2 test POL。
- 固定AI鍵はEC署名サービスの暗号化vaultに購入者EOA/80002へ限定して登録済み。このAI鍵とFacilitatorのrelayer鍵は別。秘密鍵を要求し直したりVercelへ追加したりしない。
- 既存World・Intercepta・Amoy RPC・ChatGPTサブスク認証を流用済み。公開tx/鍵binding証跡はECの `docs/agent-commerce/evidence/`。

## 最後に確認した配備

9/26 19:23 JST、VPS `160.251.205.205` のNode Facilitator codeは `8ccd520`。同revisionのCIとNode配備成功（GitHub run `36235254533` / `36235254527`）。runtimeは専用Node 22.23.3。

- 新AI Facilitator: `https://agent-facilitator-staging.jpyc-service.com`。完成manifest待ちでservice inactive/HTTP 503。
- 旧Worker: `https://facilitator-staging.jpyc-service.com`。既存決済用として別に稼働。
- `/etc/jpyc-agent-staging/facilitator.env`: root / 0600、relayer/HMAC/RPC等は作成済み。
- `/var/lib/jpyc-agent-facilitator/journal.sqlite`: 永続journal。key・nonce・raw tx・SQLite WALを維持する。
- `/etc/jpyc-agent-staging/amoy-manifest.json` と決済有効化ファイルは未作成。signer/Facilitator/workerは停止、selector/chatは稼働。

Gate/Adapter/Validatorの公開配備、Amoy Uniswap交換環境・流動性、MetaMask実機のMaxUint256＋Gate＋期限の受理、実World本人登録、公開注文・交換・購入の完走は未確認。ECのfork/fixture試験と公開chain成功を混同しない。

## 次に進めること

1. EC側で実Amoyの交換環境・Gate/Adapter/Validatorを配備し、実receipt・code hash・immutable依存をpinした完成manifestを作る。JPYCとUSDC双方のproxy implementationをpinする。USDCのslotはEIP-1967ではない。
2. EC/署名サービスと同じ80002 manifestを設定・検証する。mainnet/forkのaddressや仮値で有効化しない。既存relayerを別プロセスと共用せず、journalごと単一instanceに保つ。
3. signer→Facilitator→workerの順に起動・health確認。実機権限登録後に通常購入・交換・本人単回例外・店舗注文を照合する。
4. タイムアウト/unknownは同じ永続raw txで復旧する。新nonceの代替送金やjournal削除をしない。テスト後、小さなcommitでstagingへ反映する。

この引継ぎ追加はアプリ再配備・コントラクト配備・送金の実施ではない。再開時にはremote HEAD・VPS version・同時進行のEC変更を確認する。
