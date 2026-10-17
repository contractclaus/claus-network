// CLAUS ecosystem: current products and verified public destinations.
(() => {
const ICONS={
 transfer:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
 swap:'<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
 build:'<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
 files:'<path d="M3 6h7l2 3h9v11H3Z"/><path d="M3 6V4h7l2 2h7v3"/>',
 package:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v10l9 5 9-5V8M12 13v10M7.5 5.5l9 5V15"/>',
 runner:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
 lab:'<path d="M9 3h6m-5 0v7l-6 9a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2l-6-9V3M7 15h10"/><circle cx="10" cy="18" r=".8"/>',
 imd:'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M7 5h10M6 7l5 10m7-10-5 10"/><circle cx="12" cy="10" r="2"/>',
 surplus:'<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"/><path d="m12 8 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/>',
 inference:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4Z"/>',
 hook:'<path d="M9 5h8v9a6 6 0 0 1-12 0v-3l4 4"/><circle cx="17" cy="4" r="2.5"/>',
 programmable:'<path d="M5 20V4h8a5 5 0 0 1 0 10H9m0-6h4a1 1 0 0 1 0 2H9m0-6v16"/>',
 funding:'<path d="M3 8h17v12H3Zm0 0V5l14-2v5M15 12h6v5h-6Z"/><path d="M17.8 14.5h.4"/>',
 burn:'<path d="M13 2c1 6-6 7-6 12a5 5 0 0 0 10 0c0-2-1-4-2-5 0 3-2 4-3 3-2-2 3-4 1-10Z"/>',
 liquidity:'<path d="M3 7c3-4 6 4 9 0s6 4 9 0M3 12c3-4 6 4 9 0s6 4 9 0M3 17c3-4 6 4 9 0s6 4 9 0"/>',
 identity:'<path d="M5 5h14M12 5v14M8 19h8M5 5v3M19 5v3"/>',
 nft:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="m12 7 4 5-4 5-4-5Z"/>',
 vault:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="4"/><path d="M12 10v4m-2-2h4M6 8v1m0 6v1"/>',
 market:'<path d="M3 10h18l-2-6H5Zm1 0v10h16V10M9 20v-6h6v6M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
 community:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 2a5 5 0 0 1 3 4v3"/>',
 x:'<path d="m5 3 14 18h-4L1 3h4ZM2 21 20 3" transform="translate(1)"/>',
 pet:'<path d="M9 3h6c5 5 7 10 6 16-5 3-13 3-18 0C2 13 4 8 9 3Z"/><path d="M9 10v3m6-3v3m-6 4q3 2 6 0"/>',
 journal:'<path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M6 3v14m-3 1a3 3 0 0 1 3-1h13M10 7h5m-5 4h4"/>',
 eth:'<path d="m12 2 6 10-6 4-6-4 6-10Zm-6 13 6 7 6-7-6 4-6-4Z"/><path d="M12 2v14m-6-4 6-3 6 3"/>',
 core:'<circle cx="12" cy="12" r="8"/><path d="M9 9v3m6-3v3m-6 4q3 2 6 0"/>'
};
const base='';
// Snapshot from the current product and repository; this is not a live registry.
const DATA=[
 {id:'transfer',name:'Transfer',kind:'major',icon:'transfer',category:'Trading',status:'Available',description:'Send CLAUS to another Ethereum wallet.',url:'/Transfer'},
 {id:'swap',name:'Swap',kind:'major',icon:'swap',category:'Trading',status:'Main pool',description:'Buy and sell CLAUS through the main ETH and CLAUS pool.',url:'/Swap'},
 {id:'claus',name:'CLAUS',kind:'core',icon:'core',xy:[700,450],mobile:[330,530],size:274,category:'The centre',status:'Existing agent + token',description:'One CLAUS identity connects its token, workspaces, research and community. The wider network and approvals for other projects remain the next step.',url:base+'/Journal'},
 {id:'build',name:'Builder',kind:'major',icon:'build',xy:[420,245],mobile:[140,340],size:100,parent:'claus',category:'Workspace',status:'Existing product',description:'Private project workspaces for building with CLAUS: files, versions, scoped tools and execution. A project does not have to launch a coin.',url:base+'/Build'},
 {id:'files',name:'Project files',kind:'minor',icon:'files',xy:[230,140],mobile:[65,160],size:58,parent:'build',category:'Builder',status:'Existing capability',description:'Project files and versioned source inside the Builder workspace.',url:base+'/Build'},
 {id:'packages',name:'Solidity packages',kind:'minor',icon:'package',xy:[435,90],mobile:[240,150],size:64,parent:'build',category:'Builder',status:'Existing library',description:'Released Solidity packages and source material that builders can inspect and reuse.',url:base+'/Build?view=packages'},
 {id:'runner',name:'Code runner',kind:'minor',icon:'runner',xy:[215,285],mobile:[31,280],size:58,parent:'build',category:'Builder',status:'Existing capability',description:'Scoped, offline JavaScript and Solidity execution inside the building workflow.',url:base+'/Build'},
 {id:'lab',name:'Lab',kind:'major',icon:'lab',xy:[970,245],mobile:[520,340],size:100,parent:'claus',category:'Research',status:'Existing product',description:'Research, work and activity from CLAUS. Research and building are capabilities of the same agent.',url:base+'/Lab'},
 {id:'imd',name:'IMD',kind:'external',icon:'imd',xy:[1115,110],mobile:[420,150],size:64,parent:'lab',category:'External connection',status:'Research integration',description:'External research workers used by CLAUS. This connection does not imply that IMD belongs to the CLAUS network.',url:'https://imd.fun/'},
 {id:'surplus',name:'Surplus',kind:'external',icon:'surplus',xy:[1230,260],mobile:[595,160],size:64,parent:'lab',category:'External connection',status:'Inference upstream',description:'An external inference provider used by CLAUS. The provider remains independent of CLAUS.',url:'https://www.surplusintelligence.ai/'},
 {id:'hooks',name:'Token & hooks',kind:'major',icon:'hook',xy:[375,520],mobile:[140,660],size:108,parent:'claus',category:'On-chain',status:'Existing token + proxy hook',description:'The CLAUS token and its replaceable hook implementation, with five active functions. These are CLAUS functions, not five separate projects.',url:base+'/Hooks'},
 {id:'programmable',name:'Programmable',kind:'external',icon:'programmable',xy:[130,425],mobile:[31,440],size:60,parent:'hooks',category:'Underlying platform',status:'Existing launch foundation',description:'The platform on which CLAUS launched with a custom hook. Launching other projects through the proposed CLAUS network is still planned.'},
 {id:'funding',name:'Project Funding',kind:'minor',icon:'funding',xy:[155,565],mobile:[31,605],size:59,parent:'hooks',category:'Active hook function',status:'On-chain',description:'Main-pool fees allocate funding to development, burns, NFT rewards and participating LP rewards.',url:base+'/Hooks/Funding'},
 {id:'burn',name:'Buyback & Burn',kind:'minor',icon:'burn',xy:[230,715],mobile:[70,770],size:59,parent:'hooks',category:'Active hook function',status:'On-chain',description:'Collected fees fund batch CLAUS buybacks. Purchased tokens are burned.',url:base+'/Hooks/Burn'},
 {id:'identity',name:'Token Identity',kind:'minor',icon:'identity',xy:[395,805],mobile:[195,830],size:59,parent:'hooks',category:'Active hook function',status:'On-chain',description:'The token name and ticker can change after launch while the token address and balances remain the same.',url:base+'/Hooks/Name'},
 {id:'liquidity',name:'LP Rewards',kind:'minor',icon:'liquidity',xy:[505,655],mobile:[315,740],size:68,parent:'hooks',category:'Active hook function',status:'Existing staking interface',description:'The staking interface for eligible liquidity positions and LP rewards from the current CLAUS pool.',url:base+'/Staking/Token'},
 {id:'nft',name:'NFTs',kind:'major',icon:'nft',xy:[1020,580],mobile:[520,665],size:100,parent:'claus',category:'Collection',status:'Existing product',description:'The CLAUS NFT collection, token-backed vaults and marketplace. NFTs also connect holders to the Club.',url:base+'/Staking/NFT'},
 {id:'vault',name:'NFT Vaults',kind:'minor',icon:'vault',xy:[1220,570],mobile:[628,610],size:59,parent:'nft',category:'Active hook function',status:'On-chain',description:'Deposit CLAUS to mint a vault NFT. Stake the NFT for rewards from the published start. Unstake before redeeming its backing tokens.',url:base+'/Staking/NFT'},
 {id:'market',name:'NFT marketplace',kind:'minor',icon:'market',xy:[1215,745],mobile:[590,790],size:59,parent:'nft',category:'NFTs',status:'Existing interface',description:'The current NFT marketplace, reached through the CLAUS NFT page.',url:base+'/Staking/NFT'},
 {id:'club',name:'Club',kind:'major',icon:'community',xy:[765,710],mobile:[385,900],size:90,parent:'claus',category:'Community',status:'Existing product',description:'The holder community: conversations with CLAUS, ideas, voting and access to collaborative work.',url:base+'/Club'},
 {id:'x',name:'CLAUS on X',kind:'minor',icon:'x',xy:[650,835],mobile:[240,1030],size:58,parent:'club',category:'Community',status:'Existing account',description:'Public posts, replies and conversations from the same CLAUS identity.',url:'https://x.com/contractclaus'},
 {id:'gotchi',name:'ClausGotchi',kind:'minor',icon:'pet',xy:[920,825],mobile:[530,1030],size:63,parent:'x',category:'X experience',status:'Existing pilot',description:'The free badge-gated virtual pet pilot on X. This is a separate experience from the CLAUS NFT collection.',url:'https://x.com/contractclaus'},
 {id:'journal',name:'Journal',kind:'major',icon:'journal',xy:[700,155],mobile:[330,285],size:76,parent:'claus',category:'History',status:'Existing product',description:'The public record of changes and releases. Confirmed contract transactions can be checked separately from off-chain work.',url:base+'/Journal'},
 {id:'ethereum',name:'Ethereum',kind:'external',icon:'eth',xy:[110,780],mobile:[80,970],size:54,parent:'hooks',category:'Settlement',status:'Underlying blockchain',description:'The blockchain hosting the current CLAUS token and hook. Workspaces, research and inference are off-chain.',url:'https://etherscan.io/token/0x1b54E762aa34CF6E28E9C082F2848e28E45DA6b8'}
];

const glyph=(id)=>`<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]||id}</svg>`;
const arrow=glyph('<path d="M6 18 18 6M7 6h11v11"/>');
function mascot(){return `<svg class="mascot" viewBox="0 0 1024 1024" aria-hidden="true"><defs><filter id="ink" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 0 0 1 0"/><feComponentTransfer><feFuncA type="linear" slope="1.25" intercept="-.25"/></feComponentTransfer></filter></defs><image href="/assets/claus-logo.png" width="1024" height="1024" filter="url(#ink)"/><ellipse cx="543.5" cy="367" rx="61.5" ry="84.5" fill="#fff2d8"/><ellipse cx="690.5" cy="376.5" rx="50" ry="63" fill="#fff2d8"/><circle class="pupil" data-cx="543.5" data-cy="367" data-rx="61.5" data-ry="84.5" cx="543.5" cy="367" r="26"/><circle class="pupil" data-cx="690.5" data-cy="376.5" data-rx="50" data-ry="63" cx="690.5" cy="376.5" r="20"/></svg>`}
const ART={
transfer:()=>`<svg class="product-art transfer-art" viewBox="0 0 280 240" aria-hidden="true"><defs><linearGradient id="transfer-face" x2=".8" y2="1"><stop stop-color="#262522"/><stop offset="1" stop-color="#080808"/></linearGradient></defs><g transform="rotate(-10 140 120)"><circle cx="140" cy="126" r="96" fill="#000"/><circle cx="140" cy="118" r="96" fill="url(#transfer-face)"/><circle cx="140" cy="118" r="81" fill="none" stroke="#fff2d8" stroke-opacity=".23" stroke-width="2"/><path d="M88 118h104m-36-36 36 36-36 36" fill="none" stroke="#fff2d8" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`,
claus:()=>mascot(),
build:()=>`<svg class="product-art build-art" viewBox="3 2 300 210" aria-hidden="true"><defs><linearGradient id="build-paper" x2=".8" y2="1"><stop stop-color="#262522"/><stop offset="1" stop-color="#080808"/></linearGradient></defs><g transform="rotate(-9 150 105)"><path d="M36 27h229v153a12 12 0 0 1-12 12H45a12 12 0 0 1-12-12V39Z" fill="#000000"/><rect x="30" y="21" width="232" height="162" rx="13" fill="url(#build-paper)" stroke="#11110e" stroke-width="2"/><path d="M31 54h230" stroke="#fff2d8" stroke-opacity=".16"/><g fill="#ec673a"><circle cx="47" cy="38" r="3"/><circle cx="59" cy="38" r="3"/><circle cx="71" cy="38" r="3"/></g><path d="m108 85-29 28 29 28m83-56 29 28-29 28m-33-62-17 68" fill="none" stroke="#fff2d8" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M47 169h32" stroke="#ec673a" stroke-width="3" stroke-linecap="round"/></g><g transform="rotate(25 247 129)"><path d="M239 56h17v115l-8.5 26-8.5-26Z" fill="#f68859"/><path d="M247.5 56h8.5v115h-8.5Z" fill="#ec673a"/><path d="m239 171 8.5 26 8.5-26Z" fill="#fff2d8"/><path d="m244 187 3.5 10 3.5-10Z" fill="#11110e"/><rect x="239" y="54" width="17" height="18" rx="3" fill="#fff2d8"/></g></svg>`,
lab:()=>`<svg class="product-art lab-art" viewBox="42 8 178 162" aria-hidden="true"><defs><linearGradient id="lab-glass" x2="1" y2="1"><stop stop-color="#262522"/><stop offset="1" stop-color="#080808"/></linearGradient></defs><g transform="rotate(7 144 91)"><path d="M114 22h56v11h-8v38l42 69c8 14 0 24-16 24H96c-16 0-24-10-16-24l42-69V33h-8Z" fill="#000000"/><path d="M109 17h56v11h-8v38l42 69c8 14 0 24-16 24H91c-16 0-24-10-16-24l42-69V28h-8Z" fill="url(#lab-glass)" stroke="#11110e" stroke-width="2"/><path d="M105 102c15-10 35 10 61 0l22 37c4 7 0 12-9 12H95c-9 0-13-5-9-12Z" fill="#ec673a"/><path d="M123 40v26c0 5-3 10-5 14l-11 18" fill="none" stroke="#fff2d8" stroke-width="5" stroke-linecap="round"/><path d="M153 81h11m-3 13h11m-3 13h11" stroke="#fff2d8" stroke-width="2.5" stroke-linecap="round"/><circle cx="125" cy="123" r="7" fill="#fff2d8"/><circle cx="153" cy="135" r="4" fill="#fff2d8"/><circle cx="147" cy="111" r="3" fill="#fff2d8"/><rect x="108" y="16" width="58" height="12" rx="5" fill="#fff2d8" stroke="#11110e"/></g><g transform="rotate(-19 67 106)"><rect x="54" y="60" width="23" height="96" rx="11" fill="#11110e" stroke="#11110e" stroke-width="2"/><path d="M59 107h13v38a6.5 6.5 0 0 1-13 0Z" fill="#ec673a"/><rect x="51" y="58" width="29" height="10" rx="4" fill="#fff2d8"/><path d="M60 76v22" stroke="#fff2d8" stroke-width="3" stroke-linecap="round"/></g></svg>`,
nft:()=>`<div class="nft-stack"><div class="print back"><img src="/assets/nfts/png/021.png" alt=""></div><div class="print mid"><img src="/assets/nfts/png/035.png" alt=""></div><div class="print front"><i class="print-grain"></i><img src="/assets/nfts/png/009.png" alt=""></div></div>`,
hooks:()=>`<svg class="product-art hooks-art" viewBox="0 5 280 240" aria-hidden="true"><defs><linearGradient id="token-face" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#262522"/><stop offset="1" stop-color="#080808"/></linearGradient><linearGradient id="token-edge" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#393630"/><stop offset="1" stop-color="#000000"/></linearGradient></defs><g transform="rotate(-12 140 120)"><ellipse cx="127" cy="129" rx="96" ry="98" fill="url(#token-edge)"/><circle cx="123" cy="118" r="96" fill="url(#token-face)" stroke="#11110e" stroke-width="3"/><circle cx="123" cy="118" r="80" fill="none" stroke="#fff2d8" stroke-opacity=".26" stroke-width="2"/><path d="M61 83a69 69 0 0 1 94-23" fill="none" stroke="#fff2d8" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/><path d="M145 81v50a26 26 0 0 1-52 0v-15l13 13" fill="none" stroke="#fff2d8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="145" cy="78" r="10" fill="#11110e" stroke="#fff2d8" stroke-width="6"/><g transform="translate(199 134) rotate(15)"><path d="M1 25h-14m14 21h-14" stroke="#fff2d8" stroke-width="9" stroke-linecap="round"/><rect x="0" y="2" width="53" height="68" rx="15" fill="#11110e"/><rect x="-3" y="-4" width="53" height="68" rx="15" fill="#ec673a" stroke="#11110e" stroke-width="2"/><path d="m16 16-8 11 8 11m15-22 8 11-8 11" fill="none" stroke="#11110e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g></g></svg>`,
club:()=>`<svg class="product-art club-art" viewBox="1 0 280 240" aria-hidden="true"><defs><filter id="network-club-ink" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1 0 0 1 0"/><feComponentTransfer><feFuncA type="linear" slope="1.25" intercept="-.25"/></feComponentTransfer></filter><linearGradient id="club-paper" x2=".8" y2="1"><stop stop-color="#fff2d8"/><stop offset="1" stop-color="#fff2d8"/></linearGradient></defs><svg x="67" y="-5" width="208" height="208" viewBox="0 0 1024 1024"><image href="/assets/claus-logo.png" width="1024" height="1024" filter="url(#network-club-ink)"/><path fill="#000" d="M455 264H728L770 308V482H455Z"/><g fill="none" stroke="#fff2d8" stroke-width="24" stroke-linecap="round"><path data-club-eye data-cx="540" data-cy="366" d="M566 322C536 305 515 331 515 366C515 401 536 426 566 411"/><path data-club-eye data-cx="687" data-cy="376" d="M713 332C683 315 662 341 662 376C662 411 683 436 713 421"/></g></svg><g transform="rotate(-7 111 175)"><path d="M30 126h157a17 17 0 0 1 17 17v49a17 17 0 0 1-17 17H83l-25 20v-20H30a17 17 0 0 1-17-17v-49a17 17 0 0 1 17-17Z" fill="#11110e" transform="translate(3 5)"/><path d="M30 126h157a17 17 0 0 1 17 17v49a17 17 0 0 1-17 17H83l-25 20v-20H30a17 17 0 0 1-17-17v-49a17 17 0 0 1 17-17Z" fill="url(#club-paper)" stroke="#11110e" stroke-width="2"/><g fill="#11110e"><circle cx="72" cy="169" r="8"/><circle cx="108" cy="169" r="8"/><circle cx="144" cy="169" r="8"/></g></g></svg>`,
swap:()=>`<svg class="product-art swap-art" viewBox="0 0 280 240" aria-hidden="true"><defs><linearGradient id="swap-face" x2=".8" y2="1"><stop stop-color="#262522"/><stop offset="1" stop-color="#080808"/></linearGradient></defs><g transform="rotate(-10 140 120)"><circle cx="140" cy="126" r="96" fill="#000"/><circle cx="140" cy="118" r="96" fill="url(#swap-face)"/><circle cx="140" cy="118" r="81" fill="none" stroke="#fff2d8" stroke-opacity=".23" stroke-width="2"/><path d="M91 94h98m-21-21 21 21-21 21M189 143H91m21-21-21 21 21 21" fill="none" stroke="#fff2d8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`,
liquidity:()=>`<span class="splash-shadow"></span><svg class="splash-character" viewBox="0 0 1254 1254" aria-hidden="true"><defs><filter id="network-splash-ink" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs><image href="/assets/splash-claus.png" width="1254" height="1254" filter="url(#network-splash-ink)"/><ellipse cx="577" cy="787" rx="112" ry="134" fill="#fff2d8"/><ellipse cx="821" cy="804" rx="91" ry="111" fill="#fff2d8"/><circle class="pupil" data-cx="577" data-cy="787" data-rx="112" data-ry="134" cx="577" cy="787" r="40" fill="#000"/><circle class="pupil" data-cx="821" data-cy="804" data-rx="91" data-ry="111" cx="821" cy="804" r="33" fill="#000"/></svg>`
};
const WORLDS=[
{id:'swap',label:'Swap',size:[280,240],items:[],description:'Buy and sell CLAUS through the main pool.'},
{id:'transfer',label:'Transfer',size:[280,240],items:[],description:'Send CLAUS to another Ethereum wallet.'},
{id:'claus',label:'CLAUS',type:'core',pos:[720,455],size:[430,430],mobile:[330,560],mSize:[340,340],items:['hooks','build','lab','nft','club','liquidity'],description:'One agent, its token and the products around it. This is today’s CLAUS ecosystem. A network for independent projects is the next step.'},
{id:'build',label:'Builder',pos:[324,275],size:[280,240],mobile:[140,330],mSize:[240,206],items:['files','packages','runner'],description:'Project workspaces with files, versioned source and scoped tools. Build with CLAUS without having to launch a token.'},
{id:'lab',label:'Lab',pos:[732,151],size:[280,240],mobile:[330,130],mSize:[240,206],items:['journal','imd','surplus','inference'],description:'CLAUS research and working history, with external research and inference connections. The standalone inference service is still a local prototype.'},
{id:'nft',label:'NFTs',pos:[1130,294],size:[280,240],mobile:[520,330],mSize:[240,206],items:['vault','market'],description:'The existing CLAUS collection, token-backed vaults and trading through OpenSea. The artwork shown here comes from the actual collection.'},
{id:'hooks',label:'Token & hooks',pos:[300,629],size:[280,240],mobile:[140,790],mSize:[240,206],items:['funding','burn','identity','liquidity','vault','programmable','ethereum'],description:'Five active functions on the CLAUS token and hook. One contract system, with modules that can change over time.'},
{id:'club',label:'Club',pos:[1138,648],size:[280,240],mobile:[520,790],mSize:[240,206],items:['x','gotchi'],description:'Holder conversations, ideas and collaborative work with CLAUS. The same identity also posts on X and runs the ClausGotchi pilot.'},
{id:'liquidity',label:'Staking',pos:[727,797],size:[280,240],mobile:[330,990],mSize:[240,206],items:[],description:'The current liquidity staking interface and LP rewards for the CLAUS pool.'}
];

// This snapshot describes products and dependencies, never live activity.
DATA.push(
  {id:'lp-account',name:'CLAUS',kind:'minor',icon:'liquidity',category:'Staking',status:'Liquidity staking',description:'Provide ETH and CLAUS, manage your staked position and view your rewards.',url:'/Staking/Token'},
  {id:'nft-account',name:'NFTs',kind:'minor',icon:'nft',category:'Staking',status:'Collection & rewards',description:'Stake your NFTs from the published start, view rewards and redeem their backing after withdrawal.',url:'/Staking/NFT'}
);
const byId = new Map(DATA.map(entry => [entry.id, entry]));
Object.assign(byId.get('market'), {
  name: 'OpenSea', kind: 'external', category: 'Marketplace', status: 'External marketplace',
  description: 'Trade CLAUS NFTs on OpenSea. Minting, vault backing and redemption remain part of the CLAUS product.',
  url: 'https://opensea.io/collection/contractclaus',
});
Object.assign(byId.get('nft'), {
  description: 'The CLAUS collection and its token-backed vaults. NFT ownership is used for Club access; secondary trading is available on OpenSea.',
});
Object.assign(byId.get('claus'), {
  description: 'The CLAUS agent, its token and the products around it. Independent projects and approvals for changes to their tokens are part of the proposed network, not an existing service.',
});
byId.get('liquidity').name = 'LP Rewards';

const worldById = new Map(WORLDS.map(world => [world.id, world]));
const DESCRIPTIONS = {
  claus: 'An agent, its token and the things built around it.',
  build: 'Private projects, source files and tools for building with CLAUS.',
  lab: 'Follow CLAUS’s research, current work and activity.',
  nft: 'Collect CLAUS, access the Club and manage token-backed vaults.',
  hooks: 'One token. Five active functions.',
  club: 'Conversations, ideas and votes with CLAUS and fellow holders.',
  liquidity: 'Manage your CLAUS position, NFTs and rewards.',
};
const GROUPS = {
  claus: [{ title: 'Products', ids: ['swap', 'transfer', 'build', 'lab', 'nft', 'hooks', 'club', 'liquidity'] }],
  build: [{ title: 'Workspace', ids: ['files', 'packages', 'runner'] }],
  lab: [
    { title: 'Public record', ids: ['journal'] },
    { title: 'External services', ids: ['imd', 'surplus'] },
  ],
  nft: [
    { title: 'Collection', ids: ['vault'] },
    { title: 'Marketplace', ids: ['market'] },
  ],
  hooks: [
    { title: 'Installed functions', ids: ['funding', 'burn', 'identity', 'liquidity', 'vault'] },
    { title: 'Foundation', ids: ['programmable', 'ethereum'] },
  ],
  club: [{ title: 'Public experiences', ids: ['x', 'gotchi'] }],
  liquidity: [{ title: 'Rewards', ids: ['lp-account', 'nft-account'] }],
};

// These relationships are visible only while exploring a connected product.
const PRODUCT_LINKS = [
  { a: 'hooks', b: 'nft', fromA: 'NFT vaults are a hook function', fromB: 'Token backing and vault rules', route: 'lower' },
  { a: 'hooks', b: 'liquidity', fromA: 'Interface for liquidity staking and rewards', fromB: 'Rewards from the CLAUS pool hook' },
  { a: 'nft', b: 'club', fromA: 'Access for NFT holders', fromB: 'Membership through NFT ownership' },
];
const CONNECTIONS = [
  ...WORLDS.filter(w => w.id !== 'claus').map(w => ({ a: 'claus', b: w.id, primary: true })),
  ...PRODUCT_LINKS,
];
const OWNER = {
  'lp-account': 'liquidity', 'nft-account': 'liquidity', files: 'build', packages: 'build', runner: 'build', journal: 'lab', imd: 'lab', surplus: 'lab', inference: 'lab',
  funding: 'hooks', burn: 'hooks', identity: 'hooks', programmable: 'hooks', ethereum: 'hooks',
  vault: 'nft', market: 'nft', x: 'club', gotchi: 'club',
};
const SEARCH_WORDS = {
  'lp-account': 'claus lp rewards staking', 'nft-account': 'nft rewards collection backing',
  imd: 'research workers provider', surplus: 'models inference provider', inference: 'api compute prototype model',
  hooks: 'token coin contract proxy upgrade', market: 'nft marketplace trading', vault: 'nft mint redeem backing',
  liquidity: 'splash lp stake staking pool rewards', journal: 'history releases changes',
  files: 'documents code workspace', packages: 'solidity contracts library', runner: 'execute javascript solidity sandbox',
  gotchi: 'pet twitter x', identity: 'ticker name rename', funding: 'fees development allocation',
};

const scene = document.querySelector('#scene');
const main = document.querySelector('main');
const worlds = document.querySelector('#worlds');
const panel = document.querySelector('#panel');
const content = document.querySelector('#panel-content');
const footer = document.querySelector('#panel-footer');
const panelBack = document.querySelector('#panel-back');
const panelTrail = document.querySelector('#panel-trail');
const panelIcon = panel.querySelector('.section-icon');
const directoryButton = document.querySelector('#directory');
const aboutButton = document.querySelector('#about');
const closeButton = panel.querySelector('.close');
const positions = new Map();
const buttons = new Map();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const chevron = '<path d="m9 5 7 7-7 7"/>';
const closeGlyph = '<path d="m6 6 12 12M18 6 6 18"/>';
let current = null;
let historyStack = [];
let origin = null;
let highlighted = null;
let highlightReset;

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function iconElement(id, className = '') {
  const wrap = create('span', className);
  wrap.innerHTML = glyph(id);
  wrap.setAttribute('aria-hidden', 'true');
  return wrap;
}
function primaryWorld(view = current) {
  return view?.world || (view?.type === 'world' ? view.id : null);
}
function normalize(value) {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}
function publicName(id) {
  return worldById.get(id)?.label || byId.get(id).name;
}

for (const world of WORLDS) {
  const label = world.id === 'claus' ? 'Claus' : world.id === 'build' ? 'Build' : world.id === 'hooks' ? 'Hooks' : world.label;
  const button = create(world.id === 'claus' ? 'button' : 'a', `world ${world.type || ''}`);
  button.id = `world-${world.id}`;
  if (world.id === 'claus') {
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'network-project-directory');
    button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('claus:directory')));
  } else button.href = world.id === 'build' ? '/docs' : byId.get(world.id).url;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<div class="object" aria-hidden="true">${ART[world.id]()}</div>${world.id === 'claus' ? '' : `<span class="name" aria-hidden="true">${label}</span>`}`;
  button.addEventListener('pointerenter', event => {
    if (!panel.open && event.pointerType !== 'touch') highlight(world.id);
  });
  // A short grace period keeps neighbouring objects from flashing between states.
  button.addEventListener('pointerleave', () => {
    clearTimeout(highlightReset);
    highlightReset = setTimeout(() => highlight(primaryWorld()), 70);
  });
  button.addEventListener('focus', () => {
    if (!panel.open && button.matches(':focus-visible')) highlight(world.id);
  });
  button.addEventListener('blur', () => highlight(primaryWorld()));
  worlds.append(button);
  buttons.set(world.id, button);
}

function layout() {
  const bounds = scene.getBoundingClientRect();
  const count = WORLDS.length - 1;
  const gap = bounds.width < 600 ? 4 : 14;
  const dockSize = Math.min(bounds.width < 600 ? 46 : 58, (bounds.width - 24 - (count-1)*gap) / count);
  const dockWidth = count * dockSize + (count-1) * gap;
  let index = 0;
  for (const world of WORLDS) {
    const button = buttons.get(world.id), core = world.id === 'claus';
    const size = core ? 234 : dockSize;
    const x = core ? 0 : (bounds.width - dockWidth) / 2 + dockSize / 2 + index++ * (dockSize + gap);
    const y = core ? 0 : bounds.height - (bounds.height < 360 ? 60 : 48);
    button.style.width = core ? '430px' : '280px';
    button.style.height = core ? '430px' : '280px';
    button.style.left = x + 'px'; button.style.top = y + 'px';
    button.style.setProperty('--scale', size / (core ? 430 : 280));
    positions.set(world.id, {x, y, width:size, height:size});
  }
  scene.dispatchEvent(new CustomEvent('claus:layout'));
  placePanel();
}

function highlight(id) {
  clearTimeout(highlightReset);
  highlighted = id;
  for (const [key, button] of buttons) {
    button.classList.toggle('dim', Boolean(id && key !== id && key !== 'claus'));
    button.classList.toggle('active', Boolean(panel.open && key === primaryWorld()));
  }
}

function placePanel() {
  if (!panel.open) return;
  const bounds = scene.getBoundingClientRect();
  const selected = positions.get(primaryWorld());
  const width = panel.offsetWidth, height = panel.offsetHeight;
  const viewportHeight = window.visualViewport?.height || innerHeight;
  let left, top;
  if (innerWidth <= 680) {
    left = 16;
    top = Math.max(12, viewportHeight - height - 77);
  } else if (selected) {
    left = bounds.left + selected.x + selected.width / 2 + 22;
    if (left + width > innerWidth - 20) left = bounds.left + selected.x - selected.width / 2 - width - 22;
    left = Math.max(20, Math.min(innerWidth - width - 20, left));
    top = Math.max(20, Math.min(viewportHeight - height - 20, bounds.top + selected.y - height / 2));
  } else {
    left = 25;
    top = Math.max(20, viewportHeight - height - 81);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
function start(view, trigger) {
  historyStack = [];
  origin = trigger || directoryButton;
  navigate(view, false);
}
function navigate(view, push = true) {
  if (push && current) historyStack.push({ ...current, scroll: content.scrollTop });
  current = { ...view };
  render();
  if (!panel.open) panel.showModal();
  main.classList.add('panel-open');
  highlight(primaryWorld());
  placePanel();
  const focusTarget = view.type === 'directory' ? content.querySelector('input') : content.querySelector('h2');
  focusTarget?.focus({ preventScroll: true });
}
function goBack() {
  const view = historyStack.pop();
  if (!view) return;
  navigate(view, false);
  content.scrollTop = view.scroll || 0;
}
function closePanel(restore = true) {
  if (!panel.open) return;
  panel.close();
  main.classList.remove('panel-open');
  current = null;
  historyStack = [];
  if (restore) (origin?.isConnected ? origin : directoryButton).focus({ preventScroll: true });
  highlight(null);
}
function heading(title, category) {
  if (category) content.append(create('div', 'eyebrow', category));
  const h1 = create('h2', '', title);
  h1.id = 'panel-title';
  h1.tabIndex = -1;
  content.append(h1);
}
function setFooter(entry, label) {
  if (!entry?.url) return;
  const link = create('a', 'visit', label || `Open ${entry.name}`);
  link.href = entry.url;
  if (/^https?:/.test(entry.url)) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${link.textContent} (opens in a new tab)`);
  }
  link.insertAdjacentHTML('beforeend', /^https?:/.test(entry.url) ? arrow : glyph('<path d="M4 12h16m-6-6 6 6-6 6"/>'));
  footer.append(link);
  footer.hidden = false;
}
function row(title, subtitle, iconId, action, className = '') {
  const button = create('button', `item ${className}`);
  button.type = 'button';
  button.append(iconElement(iconId));
  const text = create('span', 'item-copy');
  text.append(create('b', '', title));
  if (subtitle) text.append(create('small', '', subtitle));
  button.append(text, iconElement(chevron, 'trailing'));
  button.addEventListener('click', action);
  return button;
}
function entrySubtitle(entry) {
  if (entry.id === 'liquidity') return 'CLAUS & NFTs';
  if (entry.kind === 'prototype') return 'Local prototype · not deployed';
  if (entry.kind === 'external') {
    const type = { imd: 'research', surplus: 'inference', market: 'marketplace', programmable: 'platform', ethereum: 'blockchain' };
    return `External · ${type[entry.id] || entry.category.toLowerCase()}`;
  }
  if (entry.id === 'gotchi') return 'Pilot on X';
  return entry.category;
}
function openEntry(id, world) {
  if (worldById.has(id)) navigate({ type: 'world', id });
  else navigate({ type: 'detail', id, world: world || OWNER[id] });
}
function section(title) {
  content.append(create('h3', 'section-title', title));
  const list = create('div', 'items');
  content.append(list);
  return list;
}
function renderWorld() {
  const world = worldById.get(current.id), entry = byId.get(current.id);
  panelIcon.innerHTML = glyph(entry.icon);
  panelTrail.textContent = 'CLAUS / ' + (entry.id === 'claus' ? 'Overview' : world.label);
  heading(world.label);
  content.append(create('p', '', DESCRIPTIONS[entry.id]));
  for (const group of GROUPS[entry.id]) {
    const list = section(group.title);
    for (const id of group.ids) {
      const child = byId.get(id);
      const installedFunction = group.title === 'Installed functions';
      const title = installedFunction ? child.name : publicName(id);
      const subtitle = child.kind === 'external' ? entrySubtitle(child) : '';
      list.append(row(title, subtitle, child.icon, () => installedFunction
        ? navigate({ type: 'detail', id, world: world.id })
        : openEntry(id, world.id)));
    }
  }
  const related = PRODUCT_LINKS.filter(link => link.a === entry.id || link.b === entry.id);
  if (related.length) {
    const list = section('Connected products');
    for (const link of related) {
      const other = link.a === entry.id ? link.b : link.a;
      const explanation = link.a === entry.id ? link.fromA : link.fromB;
      list.append(row(publicName(other), explanation, byId.get(other).icon, () => navigate({ type: 'world', id: other }), 'connection-row'));
    }
  }
  setFooter(entry, entry.id === 'claus' ? 'Open Journal' : `Open ${world.label}`);
}
function renderDetail() {
  const entry = byId.get(current.id), owner = worldById.get(current.world);
  panelIcon.innerHTML = glyph(entry.icon);
  panelTrail.textContent = `${owner?.label || 'CLAUS'} / ${entry.kind === 'external' ? 'External' : 'Details'}`;
  heading(entry.name, entry.category);
  const tag = create('span', `tag ${entry.kind === 'prototype' ? 'prototype' : ''}`);
  if (entry.kind === 'external') tag.append(iconElement('<path d="M7 17 17 7M7 7h10v10"/>'));
  tag.append(document.createTextNode(entry.status));
  content.append(tag, create('p', '', entry.description));
  if (entry.kind === 'prototype') content.append(create('div', 'context-note', 'Visible as work in progress. There is no public inference endpoint in this preview.'));
  if (entry.id === 'market') setFooter(entry, 'View collection on OpenSea');
  else setFooter(entry, entry.kind === 'external' ? `Visit ${entry.name}` : `Open ${entry.name}`);
}
function renderDirectory() {
  panelIcon.innerHTML = glyph('package');
  panelTrail.textContent = 'CLAUS / Explore';
  heading('Ecosystem');
  const wrap = create('div', 'search-wrap');
  wrap.append(iconElement('<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>'));
  const input = create('input');
  input.type = 'search';
  input.setAttribute('aria-label', 'Find a product, function or service');
  input.placeholder = 'Search ecosystem';
  input.autocomplete = 'off';
  input.value = current.query || '';
  const clear = create('button', 'search-clear');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'Clear search');
  clear.innerHTML = glyph(closeGlyph);
  input.id = 'ecosystem-search';
  const label = create('label', 'network-sr', 'Search ecosystem');
  label.htmlFor = input.id;
  wrap.append(label, input, clear);
  const count = create('div', 'search-result-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  const list = create('div', 'items directory');
  content.append(wrap, count, list);
  function results() {
    const query = normalize(input.value.trim());
    current.query = input.value;
    clear.hidden = !query;
    const words = query.split(/\s+/).filter(Boolean);
    // Search what a component is, not sentences about what it does not do.
    const ranked = query ? DATA.map(entry => {
      const name = normalize(`${entry.name} ${publicName(entry.id)}`);
      const aliases = normalize(SEARCH_WORDS[entry.id] || '');
      const category = normalize(entry.category);
      const owner = OWNER[entry.id] ? normalize(publicName(OWNER[entry.id])) : '';
      const haystack = `${name} ${aliases} ${category} ${owner}`;
      const matches = words.every(word => haystack.includes(word));
      const score = name.startsWith(query) ? 100 : name.includes(query) ? 80 : aliases.includes(query) ? 60 : 20;
      return { entry, matches, score };
    }).filter(result => result.matches).sort((a, b) => b.score - a.score) : [];
    const entries = query ? ranked.map(result => result.entry) : WORLDS.map(w => byId.get(w.id));
    count.textContent = query ? `${entries.length} ${entries.length === 1 ? 'result' : 'results'}` : '';
    list.replaceChildren();
    for (const entry of entries) {
      const owner = OWNER[entry.id];
      const subtitle = owner ? `${publicName(owner)} / ${entrySubtitle(entry)}` : '';
      list.append(row(publicName(entry.id), subtitle, entry.icon, () => openEntry(entry.id, owner)));
    }
    if (!entries.length) list.append(create('p', 'empty-search', 'No results. Try “NFT” or “rewards”.'));
  }
  input.addEventListener('input', results);
  clear.addEventListener('click', () => { input.value = ''; results(); input.focus(); });
  results();
}
function renderAbout() {
  panelIcon.innerHTML = glyph('eth');
  panelTrail.textContent = 'CLAUS';
  heading('On-chain');
  const list = section('Records');
  for (const [name, url, icon] of [
    ['Contracts', '/Contract', 'hook'],
    ['Project wallet', '/Wallet', 'funding'],
    ['Journal', '/Journal', 'journal'],
  ]) {
    const link = create('a', 'item', '');
    link.href = url;
    link.append(iconElement(icon), create('b', '', name), iconElement(chevron, 'trailing'));
    list.append(link);
  }
}

function render() {
  content.replaceChildren();
  footer.replaceChildren();
  footer.hidden = true;
  panelBack.hidden = historyStack.length === 0;
  panelIcon.hidden = historyStack.length > 0;
  if (current.type === 'world') renderWorld();
  if (current.type === 'detail') renderDetail();
  if (current.type === 'directory') renderDirectory();
  if (current.type === 'about') renderAbout();
  content.scrollTop = 0;
}

panelBack.innerHTML = glyph('<path d="m14 5-7 7 7 7"/>');
panelBack.addEventListener('click', goBack);
closeButton.innerHTML = glyph(closeGlyph);
closeButton.addEventListener('click', () => closePanel());
directoryButton.innerHTML = glyph('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>');
aboutButton.innerHTML = glyph('eth');
document.querySelector('#social').innerHTML = glyph('x');
directoryButton.addEventListener('click', () => start({ type: 'directory', query: '' }, directoryButton));
aboutButton.addEventListener('click', () => start({ type: 'about' }, aboutButton));
document.addEventListener('keydown', event => {
  if (event.key === 'Tab' && panel.open) {
    const controls = [...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled)')].filter(element => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (event.key === 'Escape' && panel.open) { event.preventDefault(); closePanel(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    start({ type: 'directory', query: '' }, directoryButton);
  }
});
panel.addEventListener('cancel', event => { event.preventDefault(); closePanel(); });
panel.addEventListener('click', event => {
  if (event.target !== panel) return;
  const r = panel.getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closePanel();
});
// The scene owns only its four pupils; the footer keeps its own controller.
const eyeTracker = window.ClausEyes.create(scene);
let eyeFrame = 0, eyeLast = 0, eyePointer = null;
function resetEyes() {
  eyePointer = null;
  if (document.hidden || reduced.matches) {
    cancelAnimationFrame(eyeFrame);
    eyeFrame = 0;
    eyeTracker.update(null, 16, true);
    return;
  }
  if (!eyeFrame) { eyeLast = 0; eyeFrame = requestAnimationFrame(drawEyes); }
}
function drawEyes(now) {
  eyeFrame = 0;
  if (document.hidden) return;
  const moving = eyeTracker.update(panel.open ? null : eyePointer, eyeLast ? Math.min(40, now - eyeLast) : 16, reduced.matches);
  eyeLast = now;
  if (moving) eyeFrame = requestAnimationFrame(drawEyes);
}
window.addEventListener('pointermove', event => {
  if (reduced.matches || event.pointerType === 'touch' || panel.open) return;
  eyePointer = {x: event.clientX, y: event.clientY};
  if (!eyeFrame) {
    eyeLast = 0;
    eyeFrame = requestAnimationFrame(drawEyes);
  }
}, {passive: true});
document.addEventListener('pointerleave', resetEyes);
reduced.addEventListener('change', resetEyes);
window.addEventListener('blur', resetEyes);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetEyes(); });
window.addEventListener('pageshow', () => highlight(null));
new ResizeObserver(layout).observe(scene);
new ResizeObserver(placePanel).observe(panel);
window.visualViewport?.addEventListener('resize', placePanel, {passive:true});
layout();
document.fonts.ready.then(layout);
window.dispatchEvent(new Event('claus:art-ready'));

})();
