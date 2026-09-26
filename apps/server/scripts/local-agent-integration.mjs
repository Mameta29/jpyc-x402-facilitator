// Run immediately after EC packages/agent-commerce/scripts/local-integration.mjs.
// The fixture contains disposable local-only keys and expires quickly.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, erc20Abi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { AgentPurchaseEngine } from '@jpyc-x402/evm';
import { parseEnvelope, paymentKeyId, gateAbi } from '@jpyc-ec/agent-commerce';
import { AgentJournal } from '../dist/agent-journal.js';
import { DurableAgentRunner } from '../dist/agent-runner.js';

const fixturePath = process.env.LOCAL_FIXTURE_DIR ?? '/private/tmp/ethtokyo-agent-local';
const f = JSON.parse(await readFile(`${fixturePath}/fixture.json`, 'utf8'));
assert.equal(f.manifest.chainId, 31337);
const rpc = process.env.LOCAL_RPC ?? 'http://127.0.0.1:18802';
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const client = createPublicClient({ chain: foundry, transport: http(rpc) });
assert.equal(await client.getChainId(), 31337);
const account = privateKeyToAccount(f.relayerPrivateKey), e = parseEnvelope(f.envelope);
const requirements = {scheme:'exact',network:'eip155:31337',asset:f.manifest.jpyc,amount:e.order.settlementAmount.toString(),payTo:e.order.payTo,maxTimeoutSeconds:300,extra:{assetTransferMethod:'erc7710',facilitatorAddresses:[f.manifest.gate],jpycPurchaseVersion:1}};
const request={x402Version:2,paymentRequirements:requirements,paymentPayload:{x402Version:2,accepted:requirements,payload:{delegationManager:f.manifest.manager,permissionContext:e.paymentContext,delegator:e.order.account},extensions:{'jpyc.purchase':{version:1,orderHash:e.intent.orderHash,intentHash:e.risk.intentHash,executionRef:toHex(9999,{size:32})}}}};
const dir=await mkdtemp(join(tmpdir(),'agent-real-recovery-'));let journal=new AgentJournal(join(dir,'journal.sqlite'));
let sent=0;
const faultyClient={...client,sendRawTransaction:async input=>{
  const jobs=journal.incomplete().filter(j=>j.raw_tx===input.serializedTransaction);assert.equal(jobs.length,1);
  sent++;await client.sendRawTransaction(input);throw new Error('deliberately lost RPC response');
}};
const engine=new AgentPurchaseEngine(f.manifest,faultyClient,account.address,async()=>f.envelope);
try {
  await assert.rejects(new AgentPurchaseEngine({...f.manifest,contracts:f.manifest.contracts.slice(0,-1)},client,account.address,async()=>f.envelope).verifyDeployment(),/missing_dependency_codehash/);
  const before=await client.readContract({address:f.manifest.jpyc,abi:erc20Abi,functionName:'balanceOf',args:[e.order.payTo]});
  const runner=new DurableAgentRunner(engine,journal,account);
  assert.equal((await runner.verify(request)).isValid,true);
  const first=await runner.settle(request);assert.ok(first.transaction);assert.equal(sent,1);
  journal.close();journal=new AgentJournal(join(dir,'journal.sqlite'));
  await client.request({method:'evm_mine',params:[]});
  const restarted=new DurableAgentRunner(engine,journal,account);
  const result=await restarted.settle(request);assert.equal(result.success,true);assert.equal(result.transaction,first.transaction);assert.equal(sent,1);
  const after=await client.readContract({address:f.manifest.jpyc,abi:erc20Abi,functionName:'balanceOf',args:[e.order.payTo]});
  assert.equal(after-before,e.order.settlementAmount);
  const key={method:'erc7710',network:'eip155:31337',payer:e.order.account,gate:f.manifest.gate,orderId:e.order.orderId};
  assert.equal((await restarted.status(key)).state,'confirmed');
  assert.equal(journal.get(paymentKeyId(key)).state,'confirmed');
  const actions=[];
  for(const action of f.gateActions){
    const current=new DurableAgentRunner(engine,journal,account),first=await current.gateAction(action),broadcasts=sent;
    assert.ok(first.transaction);journal.close();journal=new AgentJournal(join(dir,'journal.sqlite'));
    await client.request({method:'evm_mine',params:[]});
    const recovered=new DurableAgentRunner(engine,journal,account),done=await recovered.gateAction(action);
    assert.equal(done.state,'confirmed');assert.equal(done.transaction,first.transaction);assert.equal(sent,broadcasts);
    assert.equal((await recovered.gateActionStatus(done.actionId)).state,'confirmed');actions.push({kind:action.kind,transaction:done.transaction});
  }
  assert.equal(await client.readContract({address:f.manifest.gate,abi:gateAbi,functionName:'active',args:[e.order.account]}),false);
  assert.equal(await client.readContract({address:f.manifest.gate,abi:gateAbi,functionName:'spentJpyc',args:[e.order.account,e.order.policyId,0n]}),11001n*10n**18n);
  const evidence={scope:'Local real 7702/official MetaMask Manager; test token. Node SQLite restart, real transaction and receipt verification.',passed:['Gate simulation through self-hosted facilitator engine','signed raw persisted before broadcast','RPC accepted send but response deliberately lost','fresh runner and DB connection recover the original hash','Gate PurchasePaid and owner→merchant Transfer matched','exactly one token payment and one network broadcast','owner-signed policy update and revoke use the same durable nonce lane','both lifecycle actions recover after RPC response loss and restart','policy revoke is on chain and spending survives version update'],transaction:result.transaction,actions};
  await writeFile(`${fixturePath}/facilitator-evidence.json`,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally {journal.close();await rm(dir,{recursive:true,force:true});}
