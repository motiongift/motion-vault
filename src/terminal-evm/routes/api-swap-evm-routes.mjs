// API-only route encoder. The existing vault engine and click path are not imported or modified.
import { encodeFunctionData, parseAbi, isAddress, toFunctionSelector } from 'viem';
import * as V4 from './api-swap-evm-evmV4Router.mjs';
import * as B from './api-swap-evm-bnbRouter.mjs';
import * as S from './api-swap-evm-standardRouter.mjs';
export const ZERO='0x0000000000000000000000000000000000000000';
export const MAX=(1n<<256n)-1n;
const lc=x=>String(x||'').toLowerCase();
export const EVM_CHAINS=Object.freeze({
 robinhood:{id:4663,wrapped:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',v3Router:'0xcaf681a66d020601342297493863e78c959e5cb2',universalRouter:V4.UNIVERSAL_ROUTER,permit2:V4.PERMIT2,ponsFactory:'0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',flapPortal:'0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09',standard:S.STANDARD},
 bsc:{...B.BSC,ponsFactory:'0x78eae9537c0ef90dfe9b7ae964682fe8138afe31'}
});
export const ERC20_ABI=parseAbi(['function approve(address spender,uint256 amount) returns(bool)','function allowance(address owner,address spender) view returns(uint256)','function balanceOf(address owner) view returns(uint256)']);
const PONS=parseAbi(['function buy(uint256 amountIn,uint256 minOut,address to) payable','function sell(uint256 amountIn,uint256 minOut,address to)']);
const V3=parseAbi(['function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns(uint256 amountOut)']);
const err=(message)=>Object.assign(new Error(message),{code:'unsupported_route',status:422});
function addr(x){if(!isAddress(x,{strict:false}))throw err('The market route contains an invalid address');return lc(x);}
function same(a,b){return lc(a)===lc(b);}
function poolCheck(pk,token,inf=false){
 if(!pk || ![pk.currency0,pk.currency1].some(x=>same(x,token)) || same(pk.currency0,pk.currency1))throw err('The pool does not contain this token');
 addr(pk.currency0);addr(pk.currency1);addr(pk.hooks);
 if(!Number.isInteger(pk.fee)||pk.fee<0 || (pk.fee!==0x800000&&pk.fee>100000))throw err('The pool fee is outside the supported range');
 if(inf){if(!same(pk.poolManager,B.BSC.clPoolManager)||!/^0x[0-9a-fA-F]{64}$/.test(pk.parameters))throw err('The Infinity pool is invalid');}
 else if(!Number.isInteger(pk.tickSpacing)||pk.tickSpacing<=0||pk.tickSpacing>32767)throw err('The pool tick spacing is invalid');
}
function bridge(r,cfg,q){
 const hops=r.bridgeHops?.length?r.bridgeHops:r.bridgeFee?[cfg.wrapped,q]:null;
 const fees=r.bridgeFees?.length?r.bridgeFees:r.bridgeFee?[r.bridgeFee]:null;
 if(!hops||!fees||hops.length!==fees.length+1||hops.length>5||!same(hops[0],cfg.wrapped)||!same(hops.at(-1),q))throw err('No native-asset path for this market');
 hops.forEach(addr); if(fees.some(x=>![100,500,2500,3000,10000].includes(x)))throw err('Unsupported bridge pool fee');
 return {hops,fees,path:V4.encodeV3Path(hops,fees),reverse:V4.encodeV3Path([...hops].reverse(),[...fees].reverse())};
}
// Validate the server's route against immutable venue registries before signing a quote.
export async function verifyEvmRoute({chain,route:r,token,client}){
 const c=EVM_CHAINS[chain];if(!c||r?.chainId!==c.id)throw err('The market route belongs to another network');
 addr(token);
 const word=(data,i)=>data.slice(2+i*64,2+(i+1)*64);
 if(r.type==='pons'){
  addr(r.curve);addr(r.pairToken);
  const {data}=await client.call({to:c.ponsFactory,data:toFunctionSelector('getLaunchedToken(address)')+token.slice(2).toLowerCase().padStart(64,'0')});
  if(!data||data.length<962||!same('0x'+word(data,1).slice(24),r.curve)||!same('0x'+word(data,4).slice(24),r.pairToken)||BigInt('0x'+word(data,14))!==1n)throw err('The curve does not match its launchpad registry');
 }else if(r.type==='four'){
  if(chain!=='bsc'||!same(r.manager,c.fourManager)||!same(r.helper,c.fourHelper))throw err('Unknown four.meme deployment');
  const q=await client.readContract({address:c.fourHelper,abi:B.FOUR_HELPER_ABI,functionName:'trySell',args:[token,1000000000n]});
  if(!same(q[0],c.fourManager)||!same(q[1],r.quoteToken))throw err('The four.meme market has changed');
 }else if(r.type==='flap'){
  if(!same(r.portal,c.flapPortal))throw err('Unknown Flap deployment');
  const {data}=await client.call({to:c.flapPortal,data:'0xf1159a49'+token.slice(2).toLowerCase().padStart(64,'0')});
  if(!data||data.length<1154||BigInt('0x'+word(data,0))===0n||!same('0x'+word(data,9).slice(24),r.quoteToken))throw err('The Flap market has changed');
 }else if(r.type==='standard'){
  if(!c.standard||!same(r.router,c.standard.router)||!same(r.factory,c.standard.factory))throw err('Unknown Standard deployment');
  const curve=await client.readContract({address:c.standard.factory,abi:S.STANDARD_FACTORY_ABI,functionName:'curveOfToken',args:[token]});
  if(!same(curve,r.curve))throw err('Standard curve registry mismatch');
  const [stock,graduated,pk]=await Promise.all(['stock','graduated','poolKey'].map(functionName=>client.readContract({address:curve,abi:S.STANDARD_CURVE_ABI,functionName})));
  if(!same(stock,r.stock)||!S.sameHop(c.standard.stocks[lc(stock)],r.stockPool)||!S.sameHop(c.standard.ethPool,r.ethPool)||!['curve','pool'].includes(r.stage)||graduated!==(r.stage==='pool'))throw err('Standard route state changed');
  if(r.stage==='pool' && (!r.poolKey||[r.poolKey.currency0,r.poolKey.currency1,r.poolKey.fee,r.poolKey.tickSpacing,r.poolKey.hooks].some((x,i)=>String(x).toLowerCase()!==String(pk[i]).toLowerCase())))throw err('Standard pool registry mismatch');
 }else if(r.type==='v2'){
  if(!c.v2Router||!same(r.router,c.v2Router))throw err('Unknown V2 deployment');
  if(r.path?.length && (r.path.length>5||!same(r.path[0],c.wrapped)||!same(r.path.at(-1),token)))throw err('Invalid V2 path');
  (r.path||[]).forEach(addr);addr(r.quoteToken);
 }else if(r.type==='v3'){
  addr(r.quoteToken);if(![100,500,2500,3000,10000].includes(r.fee))throw err('Unsupported V3 fee');
 }else if(r.type==='v4'){
  if(chain!=='robinhood')throw err('V4 is not configured on this network');poolCheck(r.poolKey,token);
 }else if(r.type==='inf'){
  if(chain!=='bsc')throw err('Infinity is not configured on this network');poolCheck(r.poolKey,token,true);
 }else throw err('This venue does not have an API route');
}
// The outer MotionRouter checks NET minOut. Intermediate floors may be zero because all legs are atomic.
// A MAX approval amount consumes only this fresh executor's delta, never another wallet's balance.
export function buildEvmCalls({chain,route:r,token,side,amount,executor,deadline}){
 const c=EVM_CHAINS[chain];if(!c||!['buy','sell'].includes(side)||amount<=0n)throw err('Invalid route request');
 token=addr(token);executor=addr(executor);const buy=side==='buy';const calls=[];const tokens=new Set([token,lc(c.wrapped)]);
 const addToken=x=>{if(x&&!same(x,ZERO))tokens.add(addr(x));};
 const call=(target,abi,functionName,args,value=0n,approvalToken=ZERO,approvalSpender=ZERO,approvalAmount=0n,usePermit2=false,amountOffset=0)=>{
  addToken(approvalToken);calls.push({target:addr(target),value,data:encodeFunctionData({abi,functionName,args}),approvalToken:addr(approvalToken),approvalSpender:addr(approvalSpender),approvalAmount,usePermit2,amountOffset});
 };
 const ur=(enc,value=0n)=>call(c.universalRouter,V4.UNIVERSAL_ROUTER_ABI,'execute',[enc.commands,enc.inputs,BigInt(deadline)],value,buy?ZERO:token,buy?ZERO:c.universalRouter,buy?0n:amount,!buy);
 const bridgeBuy=q=>{const b=bridge(r,c,q);addToken(q);call(c.v3Router,V3,'exactInput',[{path:b.path,recipient:executor,amountIn:amount,amountOutMinimum:0n}],amount);return b;};
 const bridgeSell=q=>{const b=bridge(r,c,q);addToken(q);call(c.v3Router,V3,'exactInput',[{path:b.reverse,recipient:executor,amountIn:0n,amountOutMinimum:0n}],0n,q,c.v3Router,MAX,false,100);};
 if(r.type==='pons'){
  const native=same(r.pairToken,ZERO);if(buy&&!native)bridgeBuy(r.pairToken);
  call(r.curve,PONS,buy?'buy':'sell',[buy&&!native?0n:amount,0n,executor],buy&&native?amount:0n,buy?(native?ZERO:r.pairToken):token,buy&&native?ZERO:r.curve,buy&&!native?MAX:buy?0n:amount,false,buy&&!native?4:0);
  if(!buy&&!native)bridgeSell(r.pairToken);
 }else if(r.type==='four'){
  if(!buy&&amount%1000000000n!==0n)throw err('four.meme sell amount must be a multiple of 1000000000 base units');
  const native=same(r.quoteToken,ZERO);if(buy&&!native)bridgeBuy(r.quoteToken);
  if(buy)call(r.manager,B.FOUR_MANAGER_ABI,'buyTokenAMAP',[token,native?amount:0n,0n],native?amount:0n,native?ZERO:r.quoteToken,native?ZERO:r.manager,native?0n:MAX,false,native?0:36);
  else {call(r.manager,B.FOUR_MANAGER_ABI,'sellToken',[0n,token,amount,0n],0n,token,r.manager,amount);if(!native)bridgeSell(r.quoteToken);}
 }else if(r.type==='flap'){
  const direct=same(r.quoteToken,ZERO)||(buy&&r.nativeToQuote);const input=buy?(direct?ZERO:r.quoteToken):token;const output=buy?token:direct?ZERO:r.quoteToken;
  if(buy&&!direct)bridgeBuy(r.quoteToken);addToken(output);
  call(r.portal,B.FLAP_PORTAL_ABI,'swapExactInput',[{inputToken:input,outputToken:output,inputAmount:buy&&!direct?0n:amount,minOutputAmount:0n,permitData:'0x'}],buy&&direct?amount:0n,same(input,ZERO)?ZERO:input,same(input,ZERO)?ZERO:r.portal,buy&&!direct?MAX:buy?0n:amount,false,buy&&!direct?100:0);
  if(!buy&&!direct)bridgeSell(r.quoteToken);
 }else if(r.type==='v2'){
  const direct=!!r.path?.length;
  if(buy&&direct)call(r.router,B.PANCAKE_V2_ROUTER_ABI,'swapExactETHForTokensSupportingFeeOnTransferTokens',[0n,r.path,executor,BigInt(deadline)],amount);
  else if(!buy&&direct)call(r.router,B.PANCAKE_V2_ROUTER_ABI,'swapExactTokensForETHSupportingFeeOnTransferTokens',[amount,0n,[...r.path].reverse(),executor,BigInt(deadline)],0n,token,r.router,amount);
  else {if(buy)bridgeBuy(r.quoteToken);const input=buy?r.quoteToken:token;call(r.router,B.PANCAKE_V2_ROUTER_ABI,'swapExactTokensForTokensSupportingFeeOnTransferTokens',[buy?0n:amount,0n,buy?[r.quoteToken,token]:[token,r.quoteToken],executor,BigInt(deadline)],0n,input,r.router,buy?MAX:amount,false,buy?4:0);if(!buy)bridgeSell(r.quoteToken);}
 }else if(r.type==='v3'){
  const b=same(r.quoteToken,c.wrapped)?{hops:[c.wrapped],fees:[]}:bridge(r,c,r.quoteToken);
  const path=buy?V4.encodeV3Path([...b.hops,token],[...b.fees,r.fee]):V4.encodeV3Path([token,...[...b.hops].reverse()],[r.fee,...[...b.fees].reverse()]);
  call(c.v3Router,V3,'exactInput',[{path,recipient:executor,amountIn:amount,amountOutMinimum:0n}],buy?amount:0n,buy?ZERO:token,buy?ZERO:c.v3Router,buy?0n:amount);
 }else if(r.type==='standard'){
  if(r.stage==='curve'){
   if(buy)call(r.router,S.STANDARD_ROUTER_ABI,'buyExactIn',[r.curve,ZERO,amount,0n,0n,executor,ZERO,S.NO_FEE],amount);
   else call(r.router,S.STANDARD_ROUTER_ABI,'sellExactIn',[r.curve,amount,ZERO,0n,executor,ZERO,S.NO_FEE],0n,token,r.curve,amount);
  }else ur(S.encodeStandardSwap(buy?ZERO:token,S.standardPath(side,token,r.stock,r.poolKey,r.stockPool,r.ethPool),amount,0n),buy?amount:0n);
 }else if(r.type==='v4'||r.type==='inf'){
  const inf=r.type==='inf';const pk=r.poolKey;poolCheck(pk,token,inf);const q=V4.v4PairCurrency(pk,token);addToken(q);
  if(buy){
   const enc=same(q,ZERO)?(inf?B.encodeInfBuyNative:V4.encodeV4BuyNative)(pk,token,amount,0n):same(q,c.wrapped)?(inf?B.encodeInfBuyViaWrapped:V4.encodeV4BuyViaWeth)(pk,token,c.wrapped,amount,0n):(inf?B.encodeInfBuyViaPath:V4.encodeV4BuyViaPath)(pk,token,q,bridge(r,c,q).path,amount,0n);
   ur(enc,amount);
  }else if(same(q,ZERO)||same(q,c.wrapped))ur((inf?B.encodeInfSell:V4.encodeV4Sell)(pk,token,q,amount,0n));
  else if(!inf)ur(V4.encodeV4SellViaPath(pk,token,q,bridge(r,c,q).reverse,amount,0n,0n,executor));
  else {ur(B.encodeInfSell(pk,token,q,amount,0n));bridgeSell(q);}
 }else throw err('This venue does not have an API encoder');
 if(tokens.size>8||calls.length>12)throw err('The route is too long');
 return {calls,tokens:[...tokens]};
}
