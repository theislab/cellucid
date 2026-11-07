import{F as Hr,G as Wr,t as Lo}from"./chunk.4RO35XQH.js";import{D as Oo,F as Dr,G as Br,c as Pr,fa as Gr,g as zr,ga as Xr,j as Nr,k as We,ka as Kr,na as Vr,ra as Po,s as Ir}from"./chunk.YG5GM5R2.js";import{b as so,c as Yr}from"./chunk.R3A3K4UN.js";import{e as Fo,f as Ur,g as jr}from"./chunk.4RPXNZAP.js";import{c as xe}from"./chunk.IXWWWMZH.js";import{b as Me}from"./chunk.J6VZ5QYM.js";import{d as io,g as Ee}from"./chunk.XB45ER7C.js";import{b as $o,i as ht,l as Lr}from"./chunk.AIHKJ5NY.js";import{a}from"./chunk.BLB2Q6XA.js";var Jr=new Set(["orbit","planar","free"]),Aa=Object.freeze(["navigationMode","orbit","freefly"]),Ma=Object.freeze(["radius","targetRadius","theta","phi","target"]),Ta=Object.freeze(["position","yaw","pitch"]);function zo(e,o){if(e===null||typeof e!="object"||Array.isArray(e)||Object.getPrototypeOf(e)!==Object.prototype)return!1;let t=0;for(let r in e)Object.hasOwn(e,r)&&t++;if(t!==o.length)return!1;for(let r=0;r<o.length;r++)if(!Object.prototype.propertyIsEnumerable.call(e,o[r]))return!1;return!0}a(zo,"hasExactKeys");function Zr(e){return Array.isArray(e)&&e.length===3&&Number.isFinite(e[0])&&Number.isFinite(e[1])&&Number.isFinite(e[2])}a(Zr,"isFiniteVec3");function Ms(e){if(!Jr.has(e))throw new RangeError(`Navigation mode must be exactly "orbit", "planar", or "free"; received ${String(e)}.`);return e}a(Ms,"assertNavigationMode");function Sa(e){if(!zo(e,Aa)||!Jr.has(e.navigationMode))return!1;let o=e.orbit,t=e.freefly;return!!(zo(o,Ma)&&Number.isFinite(o.radius)&&o.radius>0&&Number.isFinite(o.targetRadius)&&o.targetRadius>0&&Number.isFinite(o.theta)&&Number.isFinite(o.phi)&&Zr(o.target)&&zo(t,Ta)&&Zr(t.position)&&Number.isFinite(t.yaw)&&Number.isFinite(t.pitch))}a(Sa,"isExactCameraState");function gt(e,o="Camera state"){if(!Sa(e))throw new TypeError(`${o} must contain an exact navigationMode plus complete orbit and freefly state.`);return e}a(gt,"assertCameraState");function co(e,o="Camera state"){let t=gt(e,o);return{navigationMode:t.navigationMode,orbit:{radius:t.orbit.radius,targetRadius:t.orbit.targetRadius,theta:t.orbit.theta,phi:t.orbit.phi,target:[...t.orbit.target]},freefly:{position:[...t.freefly.position],yaw:t.freefly.yaw,pitch:t.freefly.pitch}}}a(co,"cloneCameraState");function qr(e,o){return e[0]===o[0]&&e[1]===o[1]&&e[2]===o[2]}a(qr,"sameVec3");function Ts(e,o){let t=gt(e,"Compared camera state"),r=gt(o,"Compared camera state");return t.navigationMode!==r.navigationMode||!qr(t.orbit.target,r.orbit.target)?!1:t.navigationMode==="free"?qr(t.freefly.position,r.freefly.position)&&t.freefly.yaw===r.freefly.yaw&&t.freefly.pitch===r.freefly.pitch:t.orbit.radius===r.orbit.radius&&t.orbit.targetRadius===r.orbit.targetRadius&&t.orbit.theta===r.orbit.theta&&t.orbit.phi===r.orbit.phi}a(Ts,"cameraStatesHaveSamePose");var ka=3,Ra=Math.PI/4,Ca=Math.PI/4;function Ss(){let e=ka,o=Ra,t=Ca,r=[0,0,0],n=[e*Math.sin(t)*Math.cos(o),e*Math.cos(t),e*Math.sin(t)*Math.sin(o)],i=[r[0]+n[0],r[1]+n[1],r[2]+n[2]],s=[-n[0]/e,-n[1]/e,-n[2]/e];return{orbit:{radius:e,theta:o,phi:t,target:r},freefly:{position:i,yaw:Math.atan2(s[2],s[0]),pitch:Math.asin(s[1])}}}a(Ss,"createDefaultCameraPose");var Xe=Object.freeze({base:1,ratio:5,fadeInFraction:.6}),Do=Object.freeze({floor:Object.freeze({minCellCssPx:22,maxFamilySpacing:2.5}),backdrop:Object.freeze({minCellCssPx:16,maxFamilySpacing:1/0})}),pt=Object.freeze({lineWidthCssPx:1,majorLineWidthCssPx:1,dotRadiusCssPx:1.05,majorDotRadiusCssPx:1.3}),Be=Object.freeze({floorClearance:.12,innerRadius:2.6,outerRadius:8.5,grazingFadeStart:.035,grazingFadeEnd:.2,clearanceFade:.06,poolReach:1.8,poolRoundness:.4}),Cs=.3,Bo=Object.freeze({studio:Object.freeze({surface:Object.freeze([236,236,236]),glow:Object.freeze([246,246,246]),ink:Object.freeze([96,96,96]),lineMinorAlpha:.15,lineMajorAlpha:.28,dotMinorAlpha:.32,dotMajorAlpha:.42,poolAlpha:.09}),"studio-dark":Object.freeze({surface:Object.freeze([17,17,17]),glow:Object.freeze([27,27,27]),ink:Object.freeze([200,200,200]),lineMinorAlpha:.12,lineMajorAlpha:.22,dotMinorAlpha:.26,dotMajorAlpha:.34,poolAlpha:.09})});function Ut(e){return[e[0]/255,e[1]/255,e[2]/255]}a(Ut,"studioColor01");function wt(e,o,t){let r=Math.max(0,Math.min(1,(t-e)/(o-e)));return r*r*(3-2*r)}a(wt,"smoothstep");function $a(e,o,t){let r=e.minCellCssPx,n=e.maxFamilySpacing;return{presence:wt(r*Xe.fadeInFraction,r,t)*(n===1/0?1:1-wt(n*.5,n,o)),majorness:wt(r,r*Xe.ratio,t)}}a($a,"studioFamilyWeights");function Uo(e){return Xe.base*Xe.ratio**e}a(Uo,"studioFamilySpacing");function Qr(e,o,t){return Math.floor(Math.log(o*e.minCellCssPx*t/Xe.base)/Math.log(Xe.ratio))}a(Qr,"studioFamilyLevel");function jo({surface:e,coarsestLevel:o,level:t,footprint:r,pixelRatio:n,minorAlpha:i,majorAlpha:s}){let h=0,c=0;for(let f=t;f<=Math.min(o,t+2);f++){let d=Uo(f),l=$a(e,d,d/r/n),m=l.presence*(i+(s-i)*l.majorness);m>h&&(h=m,c=l.majorness)}return{strength:h,majorness:c}}a(jo,"studioMarkStrength");function lo(e){return 1-wt(0,1,e)}a(lo,"studioFalloff");function en(e){return 1-wt(Be.innerRadius,Be.outerRadius,e)}a(en,"studioStageFade");function fo(e){return wt(Be.grazingFadeStart,Be.grazingFadeEnd,e)}a(fo,"studioGrazingFade");function uo(e){return wt(0,Be.clearanceFade,e)}a(uo,"studioClearanceFade");function $s(e,o){return e<3||o==="planar"?1:0}a($s,"studioSurfacePlanarity");function tn(e,o){return o.floor=1-e,o.backdrop=e,o}a(tn,"resolveStudioSurfaceWeights");function Os(e,o,t){let r=e===null?-1:e.min[1];return t.floorY=r-Be.floorClearance,t.flat=o<3,t.stageX=e===null?0:(e.min[0]+e.max[0])*.5,t.stageZ=e===null?0:(e.min[2]+e.max[2])*.5,t.centerY=e===null?0:(e.min[1]+e.max[1])*.5,t.extentX=e===null?1:(e.max[0]-e.min[0])*.5,t.extentY=e===null?1:(e.max[1]-e.min[1])*.5,t.extentZ=e===null?1:(e.max[2]-e.min[2])*.5,t}a(Os,"resolveStudioPaneGeometry");function on(e,o,t){if(o.flat)return t.normalX=0,t.normalY=0,t.normalZ=-1,t.offset=-o.stageZ,t.uX=1,t.uY=0,t.uZ=0,t.vX=0,t.vY=1,t.vZ=0,t;let r=-e[2],n=-e[6],i=-e[10],s=o.extentX*Math.abs(r)+o.extentY*Math.abs(n)+o.extentZ*Math.abs(i)+Be.floorClearance;return t.normalX=r,t.normalY=n,t.normalZ=i,t.offset=r*o.stageX+n*o.centerY+i*o.stageZ+s,t.uX=e[0],t.uY=e[4],t.uZ=e[8],t.vX=e[1],t.vY=e[5],t.vZ=e[9],t}a(on,"resolveStudioBackdropPlane");function No(e,o,t,r,n){let i=e[3]*o+e[7]*t+e[11]*r+e[15];return i>1e-9?(n[0]=(e[0]*o+e[4]*t+e[8]*r+e[12])/i,n[1]=(e[1]*o+e[5]*t+e[9]*r+e[13])/i,!0):!1}a(No,"projectToNdc");var Io=[0,0],kt=[0,0];function rn(e,o,t,r){r.gate=0;let n=o[1]-t.floorY,i=Math.hypot(o[0]-t.stageX,n,o[2]-t.stageZ);if(!(n>0)||!(i>0))return r;let s=uo(n)*fo(n/i);if(!(s>0))return r;let h=Math.max(t.extentX,t.extentZ)*Be.poolRoundness,c=Math.max(t.extentX,h)*Be.poolReach,f=Math.max(t.extentZ,h)*Be.poolReach;if(!(c>0)||!(f>0))return r;let d=t.floorY;if(!No(e,t.stageX,d,t.stageZ,Io)||(r.centerX=Io[0],r.centerY=Io[1],!No(e,t.stageX+c,d,t.stageZ,kt))||(r.axisAX=kt[0]-r.centerX,r.axisAY=kt[1]-r.centerY,!No(e,t.stageX,d,t.stageZ+f,kt)))return r;r.axisBX=kt[0]-r.centerX,r.axisBY=kt[1]-r.centerY;let l=r.axisAX*r.axisBY-r.axisBX*r.axisAY;return Math.abs(l)>1e-9&&(r.gate=s),r}a(rn,"resolveStudioPool");var nn=Object.freeze(["white","grid","studio","atelier","abyss","aurora","black","grid-dark","studio-dark","nebula","abyss-dark","aurora-dark"]),Ps=Object.freeze([Object.freeze({label:"Light",backgrounds:Object.freeze(["white","grid","studio","atelier","abyss","aurora"])}),Object.freeze({label:"Dark",backgrounds:Object.freeze(["black","grid-dark","studio-dark","nebula","abyss-dark","aurora-dark"])})]);var Oa=Object.freeze({white:"White",grid:"Grid (light)",studio:"Studio (light)",atelier:"Atelier (light)",abyss:"Abyss (light)",aurora:"Aurora (light)",black:"Black","grid-dark":"Grid (dark)","studio-dark":"Studio (dark)",nebula:"Nebula (dark)","abyss-dark":"Abyss (dark)","aurora-dark":"Aurora (dark)"}),an=Object.freeze(["studio","studio-dark"]),sn=Object.freeze(["atelier","abyss","aurora","nebula","abyss-dark","aurora-dark"]),zs=Object.freeze(["grid","grid-dark"]),cn=`Viewer background must be exactly one of ${nn.map(e=>`"${e}"`).join(", ")}.`;function ho(e){return nn.includes(e)}a(ho,"isViewerBackground");var st=Object.freeze({atelier:Object.freeze({id:"atelier",family:"atelier",program:"atelier",tone:"light",label:"Atelier (light)",surface:Object.freeze([238,235,230]),defaultTints:Object.freeze([Object.freeze([.55,.52,.48]),Object.freeze([.5,.52,.56]),Object.freeze([.52,.5,.5])])}),nebula:Object.freeze({id:"nebula",family:"atelier",program:"nebula",tone:"dark",label:"Nebula (dark)",surface:Object.freeze([7,8,14]),defaultTints:Object.freeze([Object.freeze([.36,.42,.95]),Object.freeze([.85,.32,.62]),Object.freeze([.2,.75,.8])])}),abyss:Object.freeze({id:"abyss",family:"abyss",program:"abyss",tone:"light",label:"Abyss (light)",surface:Object.freeze([214,234,234]),defaultTints:Object.freeze([Object.freeze([.2,.7,.75]),Object.freeze([.3,.55,.85]),Object.freeze([.55,.8,.6])])}),"abyss-dark":Object.freeze({id:"abyss-dark",family:"abyss",program:"abyss",tone:"dark",label:"Abyss (dark)",surface:Object.freeze([3,14,21]),defaultTints:Object.freeze([Object.freeze([.15,.85,.85]),Object.freeze([.25,.55,1]),Object.freeze([.45,1,.7])])}),aurora:Object.freeze({id:"aurora",family:"aurora",program:"aurora",tone:"light",label:"Aurora (light)",surface:Object.freeze([236,234,236]),defaultTints:Object.freeze([Object.freeze([1,.72,.55]),Object.freeze([.62,.72,.95]),Object.freeze([.95,.65,.75])])}),"aurora-dark":Object.freeze({id:"aurora-dark",family:"aurora",program:"aurora",tone:"dark",label:"Aurora (dark)",surface:Object.freeze([6,10,22]),defaultTints:Object.freeze([Object.freeze([.25,1,.6]),Object.freeze([.65,.35,1]),Object.freeze([.2,.8,.95])])})}),Ds=Object.freeze(Object.keys(st));function Rt(e){return typeof e=="string"&&Object.prototype.hasOwnProperty.call(st,e)}a(Rt,"isBackdropLook");function fn(e){let o=st[e].surface;return[o[0]/255,o[1]/255,o[2]/255]}a(fn,"backdropLookSurface01");function Go(e){return e<=.04045?e/12.92:((e+.055)/1.055)**2.4}a(Go,"srgbToLinear");function ln(e){return .2126*e[0]+.7152*e[1]+.0722*e[2]}a(ln,"linearLuminance");function Xo(e,o,t=[0,0,0]){let r=[Go(e[0]),Go(e[1]),Go(e[2])],n=Math.max(ln(r),1e-4);for(let s=0;s<3;s++){let h=r[s]/n;t[s]=1+(h-1)*o}let i=Math.max(ln(t),1e-4);for(let s=0;s<3;s++)t[s]=Math.max(0,t[s]/i);return t}a(Xo,"shapeBackdropTint");function un(e,o,t=3,r=65536){let n=Math.floor(e.length/4),i=new Float32Array(32768),s=new Float32Array(32768*3),h=Math.max(1,Math.floor(n/r)),c=0;for(let l=0;l<n;l+=h){if(o!==null&&o[l]===0)continue;let m=e[l*4],w=e[l*4+1],y=e[l*4+2],x=Math.max(m,w,y),S=Math.min(m,w,y),g=.15+(x-S)/255,_=m>>3<<10|w>>3<<5|y>>3;i[_]+=g,s[_*3]+=m*g,s[_*3+1]+=w*g,s[_*3+2]+=y*g,c+=1}let f=[],d=[];for(let l=0;l<t;l++){let m=-1,w=0;for(let _=0;_<32768;_++)i[_]>w&&(w=i[_],m=_);if(m<0)break;let y=i[m];f.push([s[m*3]/y/255,s[m*3+1]/y/255,s[m*3+2]/y/255]),d.push(y);let x=m>>10,S=m>>5&31,A=m&31,g=5;for(let _=Math.max(0,x-g);_<=Math.min(31,x+g);_++)for(let k=Math.max(0,S-g);k<=Math.min(31,S+g);k++)for(let v=Math.max(0,A-g);v<=Math.min(31,A+g);v++)i[_<<10|k<<5|v]=0}return{colors:f,weights:d,sampled:c}}a(un,"extractDominantColors");var jt=512,Ct=Object.freeze((()=>{let e=[-.42,1,.38],o=Math.hypot(e[0],e[1],e[2]);return e.map(t=>t/o)})());var Gt=.32;var Fa="background-select",dn=2,hn=Object.freeze({grid:Object.freeze({kind:"grid",mode:"grid",opacity:.85,spacing:.2,lineWidth:.01,size:dn,lineColor:Object.freeze([.56,.56,.57]),surfaceColor:Object.freeze([.965,.965,.97]),axisColors:Object.freeze({x:Object.freeze([.48,.46,.46]),y:Object.freeze([.46,.48,.46]),z:Object.freeze([.46,.46,.48])})}),"grid-dark":Object.freeze({kind:"grid",mode:"grid-dark",opacity:.75,spacing:.2,lineWidth:.008,size:dn,lineColor:Object.freeze([.38,.38,.42]),surfaceColor:Object.freeze([.08,.09,.1]),axisColors:Object.freeze({x:Object.freeze([.62,.58,.58]),y:Object.freeze([.58,.62,.58]),z:Object.freeze([.58,.58,.62])})}),...Object.fromEntries(an.map(e=>[e,Object.freeze({kind:"studio",mode:e,palette:Bo[e],surfaceColor:Object.freeze(Ut(Bo[e].surface))})])),...Object.fromEntries(sn.map(e=>[e,Object.freeze({kind:"look",mode:e,surfaceColor:Object.freeze(fn(e))})]))});function pn(e){if(e===null||typeof e!="object"||typeof e.getElementById!="function")return null;let o=e.getElementById(Fa);return o===null||typeof o!="object"||typeof o.value!="string"?null:ho(o.value)?o.value:null}a(pn,"readActiveViewerBackground");function La(e){return e===null?null:hn[e]??null}a(La,"readReferenceGridAppearance");function Hs(e){return La(pn(e))}a(Hs,"readActiveReferenceGridAppearance");function mn(e,o){if(e===null)return null;if(!Object.values(hn).includes(e))throw new TypeError(`${o} must be null or a published viewer reference-layer appearance.`);return e}a(mn,"assertReferenceGridAppearance");function Ws(e){return pn(e)!==null?[]:[{title:"Active viewer background unavailable",detail:"The background control could not be read, so whether the viewer is drawing a reference layer — and which one, in which theme — cannot be confirmed. Reload the page and export again."}]}a(Ws,"buildViewerBackgroundFidelityWarnings");var Pa=new Set(["png","svg"]),za=new Set(["full-vector","optimized-vector","hybrid"]),Na=new Set(["right","bottom"]),Ia=new Set(["viewer","white","transparent","custom"]),Da=new Set(Br),Yo=Object.freeze(["axisLabelFontSizePx","background","backgroundColor","centroidLabelFontSizePx","crop","depthSort3d","emphasizeSelection","exportAllViews","fontFamily","fontSizePx","height","includeAxes","includeLegend","legendFontSizePx","legendPosition","optimizedTargetCount","referenceGrid","selectionMutedOpacity","showOrientation","signal","strategy","tickFontSizePx","title","titleFontSizePx","width","xLabel","yLabel"]),Ba=Object.freeze([...Yo,"dpi","format"].sort()),Ua=Object.freeze([...Yo,"jobs"].sort()),ja=Object.freeze(["dpi","format"]),Ga=Object.freeze(["dpi","format","height","meta","options","selection","title","views","width"]),xn=Object.freeze(Yo.filter(e=>e!=="exportAllViews"&&e!=="signal").sort()),Xa=Object.freeze(["cameraState","data","id","label","renderState","scientificState"]),Ha=Object.freeze(["centroidColors","centroidFlags","centroidLabelTexts","centroidPositions","colors","pointCount","positions","transparency"]),Wa=Object.freeze(["labels","points"]),Ya=Object.freeze(["highlightArray","totalCount","visibleCount"]),Ka=Object.freeze(["datasetGeneration","dimensionLevel","drawOrder","fieldKey","fieldKind","filters","geometryGeneration","legendModel","lodMembership","lodSizeMultiplier","normTransform","pointLayers"]),Va=Object.freeze(["fieldKey","fieldKind","filters","id","label"]),Za=Object.freeze(["center","scale"]),qa=Object.freeze(["antialias","backdrop","bgColor","cameraDistance","cameraPosition","far","fogColor","fogDensity","fogFar","fogNear","fov","lightDir","lightingStrength","modelMatrix","mvpMatrix","near","pointSize","projectionMatrix","shaderQuality","sizeAttenuation","viewMatrix","viewportHeight","viewportWidth"]),Ja=Object.freeze(["centerY","extentX","extentY","extentZ","flat","floorY","glowCenterX","look","pixelRatio","planarity","stageX","stageZ"]),Qa=Object.freeze(["ambient","id","shadow","time","tints"]),ei=Object.freeze(["packed","size","window"]);function ti(e,o){if(e!==null){if(Ee(e,Qa,o),!Rt(e.id))throw new TypeError(`${o}.id must name a background look.`);if(!Array.isArray(e.tints)||e.tints.length!==3)throw new TypeError(`${o}.tints must be three colours.`);if(e.tints.forEach((t,r)=>{if(!Array.isArray(t)||t.length!==3)throw new TypeError(`${o}.tints[${r}] must be an RGB triple.`);t.forEach((n,i)=>Ye(n,`${o}.tints[${r}][${i}]`,0))}),Ye(e.time,`${o}.time`,0),e.ambient!==0&&e.ambient!==1)throw new TypeError(`${o}.ambient must be exactly 0 or 1.`);if(e.shadow!==null){if(Ee(e.shadow,ei,`${o}.shadow`),!Number.isSafeInteger(e.shadow.size)||e.shadow.size<=0)throw new TypeError(`${o}.shadow.size must be a positive integer.`);if(!(e.shadow.packed instanceof Uint16Array)||e.shadow.packed.length!==e.shadow.size*e.shadow.size*2)throw new TypeError(`${o}.shadow.packed must be the size² × 2 half-float map.`);if(!Array.isArray(e.shadow.window)||e.shadow.window.length!==3)throw new TypeError(`${o}.shadow.window must be [centre u, centre v, half size].`);e.shadow.window.forEach((t,r)=>Ye(t,`${o}.shadow.window[${r}]`))}}}a(ti,"assertBackdropLook");function vt(e,o,{allowEmpty:t=!0}={}){if(typeof e!="string"||!t&&e.trim().length===0)throw new TypeError(`${o} must be ${t?"a string":"a non-empty string"}.`)}a(vt,"assertString");function mt(e,o){if(typeof e!="boolean")throw new TypeError(`${o} must be an exact boolean.`)}a(mt,"assertBoolean");function Ko(e,o){let t=globalThis.AbortSignal,r=typeof t=="function"?Object.getOwnPropertyDescriptor(t.prototype,"aborted")?.get:null;if(e===null||typeof e!="object"||typeof r!="function"||typeof e.addEventListener!="function"||typeof e.removeEventListener!="function")throw new TypeError(`${o} must be an AbortSignal.`);try{return r.call(e)}catch{throw new TypeError(`${o} must be an AbortSignal.`)}}a(Ko,"readFigureExportAbortState");function yn(e,o="Figure export signal"){return Ko(e,o),e}a(yn,"assertFigureExportSignal");function bn(e){return e===null?!1:Ko(e,"Figure export signal")}a(bn,"isFigureExportSignalAborted");function oi(e){if(e!==null&&Ko(e,"Figure export signal"))throw Fo(e)}a(oi,"throwIfFigureExportAborted");function nc(e,o){return e===null?Promise.resolve(o):(yn(e),oi(e),new Promise((t,r)=>{let n=!1,i=a(()=>{},"stopListening"),s=a((c,f)=>{n||(n=!0,i(),c(f))},"settle"),h=a(()=>s(r,Fo(e)),"settleAborted");i=jr(e,h),Promise.resolve(o).then(c=>{bn(e)?h():s(t,c)},c=>{bn(e)?h():s(r,c)})}))}a(nc,"awaitFigureExportAbortable");function ke(e,o,t,r=1/0){if(!Number.isSafeInteger(e)||e<t||e>r)throw new RangeError(`${o} must be a safe integer from ${t} through ${r}.`)}a(ke,"assertInteger");function Ye(e,o,t=-1/0,r=1/0){if(typeof e!="number"||!Number.isFinite(e)||e<t||e>r)throw new RangeError(`${o} must be a finite number from ${t} through ${r}.`)}a(Ye,"assertFiniteNumber");function mo(e,o){if(!Pa.has(e))throw new TypeError(`${o} must be exactly "svg" or "png".`)}a(mo,"assertFormat");function gn(e,o){if(ke(e.width,`${o}.width`,10),ke(e.height,`${o}.height`,10),mt(e.exportAllViews,`${o}.exportAllViews`),vt(e.title,`${o}.title`),mt(e.includeAxes,`${o}.includeAxes`),mt(e.includeLegend,`${o}.includeLegend`),!Na.has(e.legendPosition))throw new TypeError(`${o}.legendPosition must be "right" or "bottom".`);if(vt(e.xLabel,`${o}.xLabel`),vt(e.yLabel,`${o}.yLabel`),!Ia.has(e.background))throw new TypeError(`${o}.background is not a current export background.`);if(typeof e.backgroundColor!="string"||!/^#[0-9a-fA-F]{6}$/.test(e.backgroundColor))throw new TypeError(`${o}.backgroundColor must be an exact #RRGGBB color.`);vt(e.fontFamily,`${o}.fontFamily`,{allowEmpty:!1});for(let t of["fontSizePx","legendFontSizePx","tickFontSizePx","axisLabelFontSizePx","titleFontSizePx","centroidLabelFontSizePx"])ke(e[t],`${o}.${t}`,1);return so(e.crop),mn(e.referenceGrid,`${o}.referenceGrid`),mt(e.showOrientation,`${o}.showOrientation`),mt(e.depthSort3d,`${o}.depthSort3d`),mt(e.emphasizeSelection,`${o}.emphasizeSelection`),Ye(e.selectionMutedOpacity,`${o}.selectionMutedOpacity`,0,1),e}a(gn,"assertBaseRequestValues");function wn(e,o,t){return Ee(e,o,t),yn(e.signal,`${t}.signal`),gn(e,t)}a(wn,"assertBaseRequest");function Vo(e,o,t){if(!o){if(e.strategy!==null)throw new TypeError(`${t}.strategy must be null for PNG-only export.`);if(e.optimizedTargetCount!==null)throw new TypeError(`${t}.optimizedTargetCount must be null for PNG-only export.`);return}if(!za.has(e.strategy))throw new TypeError(`${t}.strategy must be one explicit current SVG export strategy.`);if(e.strategy==="optimized-vector"){ke(e.optimizedTargetCount,`${t}.optimizedTargetCount`,1e3,5e6);return}if(e.optimizedTargetCount!==null)throw new TypeError(`${t}.optimizedTargetCount must be null unless strategy is "optimized-vector".`)}a(Vo,"assertStrategyContract");function ri(e,o){if(Ee(e,ja,o),mo(e.format,`${o}.format`),e.format==="png")ke(e.dpi,`${o}.dpi`,72);else if(e.dpi!==null)throw new TypeError(`${o}.dpi must be null for SVG export.`)}a(ri,"assertJob");function ac(e){if(wn(e,Ba,"Figure export request"),mo(e.format,"Figure export request.format"),e.format==="png")ke(e.dpi,"Figure export request.dpi",72);else if(e.dpi!==null)throw new TypeError("Figure export request.dpi must be null for SVG export.");return Vo(e,e.format==="svg","Figure export request"),e}a(ac,"assertFigureExportSingleRequest");function ic(e){if(wn(e,Ua,"Figure export batch request"),!Array.isArray(e.jobs)||e.jobs.length===0)throw new TypeError("Figure export batch request.jobs must be a non-empty array.");let o=new Set;return e.jobs.forEach((t,r)=>{ri(t,`Figure export batch request.jobs[${r}]`);let n=t.format==="png"?`png:${t.dpi}`:"svg";if(o.has(n))throw new Error(`Duplicate figure export job "${n}".`);o.add(n)}),Vo(e,e.jobs.some(t=>t.format==="svg"),"Figure export batch request"),e}a(ic,"assertFigureExportBatchRequest");function ni(e,o="Figure export view id"){return vt(e,o,{allowEmpty:!1}),e}a(ni,"assertFigureExportViewId");function Ho(e,o,t,{checkValues:r=!0}={}){if(!(e instanceof Float32Array)||e.length!==o)throw new TypeError(`${t} must be a Float32Array of length ${o}.`);if(r){for(let n of e)if(!Number.isFinite(n))throw new TypeError(`${t} must contain only finite numbers.`)}}a(Ho,"assertFloat32Array");function po(e,o,t){if(!(e instanceof Uint8Array)||e.length!==o)throw new TypeError(`${t} must be a Uint8Array of length ${o}.`)}a(po,"assertUint8Array");function Wo(e,o,t=new Set){if(!(e===null||typeof e=="string"||typeof e=="boolean")){if(typeof e=="number"){Ye(e,o);return}if(typeof e!="object"||t.has(e))throw new TypeError(`${o} must contain only acyclic, owned legend data.`);if(!(e instanceof Uint8Array)){if(t.add(e),Array.isArray(e)){let r=Reflect.ownKeys(e);if(r.length!==e.length+1||!r.includes("length"))throw new TypeError(`${o} must be one dense array without custom properties.`);for(let n=0;n<e.length;n++){if(!Object.hasOwn(e,n))throw new TypeError(`${o} must not contain sparse entries.`);Wo(e[n],`${o}[${n}]`,t)}t.delete(e);return}io(e,o);for(let r of Reflect.ownKeys(e)){let n=Object.getOwnPropertyDescriptor(e,r);if(typeof r!="string"||n===void 0||n.enumerable!==!0||!Object.hasOwn(n,"value"))throw new TypeError(`${o} must contain only enumerable string data properties.`);Wo(n.value,`${o}.${r}`,t)}t.delete(e)}}}a(Wo,"assertOwnedLegendValue");function ai(e,o){if(Ee(e,Ja,o),typeof e.flat!="boolean")throw new TypeError(`${o}.flat must be an exact boolean.`);for(let t of["centerY","floorY","stageX","stageZ"])Ye(e[t],`${o}.${t}`);for(let t of["extentX","extentY","extentZ"])Ye(e[t],`${o}.${t}`,0);if(Ye(e.glowCenterX,`${o}.glowCenterX`,-1,1),Ye(e.pixelRatio,`${o}.pixelRatio`,Number.MIN_VALUE),e.planarity!==0&&e.planarity!==1)throw new TypeError(`${o}.planarity must be exactly 0 or 1.`);ti(e.look,`${o}.look`)}a(ai,"assertBackdrop");function ii(e,o){Ee(e,qa,o),ai(e.backdrop,`${o}.backdrop`);for(let t of["mvpMatrix","viewMatrix","modelMatrix","projectionMatrix"])Ho(e[t],16,`${o}.${t}`);for(let t of["fogColor","bgColor","lightDir"])Ho(e[t],3,`${o}.${t}`);if(!Array.isArray(e.cameraPosition)||e.cameraPosition.length!==3)throw new TypeError(`${o}.cameraPosition must be a three-number array.`);e.cameraPosition.forEach((t,r)=>{Ye(t,`${o}.cameraPosition[${r}]`)});for(let t of["pointSize","sizeAttenuation","fov","near","far","lightingStrength","fogDensity","fogNear","fogFar","cameraDistance"])Ye(e[t],`${o}.${t}`);if(ke(e.viewportWidth,`${o}.viewportWidth`,1),ke(e.viewportHeight,`${o}.viewportHeight`,1),typeof e.antialias!="boolean")throw new TypeError(`${o}.antialias must be an exact boolean.`);if(!Da.has(e.shaderQuality))throw new TypeError(`${o}.shaderQuality is not a current shader quality.`);if(e.fogNear<0||e.fogFar<e.fogNear)throw new RangeError(`${o} fog range must satisfy 0 <= fogNear <= fogFar.`)}a(ii,"assertRenderState");function si(e,o,t){Ee(e,Ha,t),ke(e.pointCount,`${t}.pointCount`,0),ke(o,`${t} dimensionLevel`,1,3),Ho(e.positions,e.pointCount*o,`${t}.positions`,{checkValues:!1}),po(e.colors,e.pointCount*4,`${t}.colors`),po(e.transparency,e.pointCount,`${t}.transparency`),Ee(e.centroidFlags,Wa,`${t}.centroidFlags`),mt(e.centroidFlags.points,`${t}.centroidFlags.points`),mt(e.centroidFlags.labels,`${t}.centroidFlags.labels`);let r=[e.centroidPositions,e.centroidColors].map(i=>i!==null);if(r[0]!==r[1])throw new TypeError(`${t} centroid positions and colors must both be present or both be null.`);let n=0;if(r[0]){if(!(e.centroidPositions instanceof Float32Array)||e.centroidPositions.length%3!==0)throw new TypeError(`${t}.centroidPositions must contain xyz triplets.`);n=e.centroidPositions.length/3,po(e.centroidColors,n*4,`${t}.centroidColors`)}if(!Array.isArray(e.centroidLabelTexts)||e.centroidLabelTexts.some(i=>typeof i!="string"))throw new TypeError(`${t}.centroidLabelTexts must be an array of strings.`);if(e.centroidFlags.labels&&e.centroidLabelTexts.length!==n)throw new Error(`${t}.centroidLabelTexts must match the published centroid count when labels are enabled.`)}a(si,"assertViewData");function ci(e,o,t){if(Ee(e,Ya,t),ke(e.totalCount,`${t}.totalCount`,0,o),ke(e.visibleCount,`${t}.visibleCount`,0,e.totalCount),e.totalCount===0){if(e.highlightArray!==null)throw new TypeError(`${t}.highlightArray must be null when no cells are highlighted.`);return}po(e.highlightArray,o,`${t}.highlightArray`)}a(ci,"assertSelectionSnapshot");function li(e,o,t){if(Ee(e,Ka,t),ke(e.datasetGeneration,`${t}.datasetGeneration`,0),ke(e.dimensionLevel,`${t}.dimensionLevel`,1,3),ke(e.geometryGeneration,`${t}.geometryGeneration`,1),e.fieldKey!==null&&typeof e.fieldKey!="string")throw new TypeError(`${t}.fieldKey must be a string or null.`);if(e.fieldKind!==null&&typeof e.fieldKind!="string")throw new TypeError(`${t}.fieldKind must be a string or null.`);if(e.fieldKey===null!=(e.fieldKind===null))throw new TypeError(`${t} field key and kind describe one field and must be published together.`);if(!Array.isArray(e.filters)||e.filters.some(r=>typeof r!="string"))throw new TypeError(`${t}.filters must be an array of strings.`);if(e.legendModel!==null&&(io(e.legendModel,`${t}.legendModel`),Wo(e.legendModel,`${t}.legendModel`)),Kr(e.lodMembership,{pointCount:o.pointCount,dimensionLevel:e.dimensionLevel,label:`${t}.lodMembership`}),Vr(e.drawOrder,{pointCount:o.pointCount,label:`${t}.drawOrder`}),Ye(e.lodSizeMultiplier,`${t}.lodSizeMultiplier`,Number.MIN_VALUE),e.pointLayers===null||typeof e.pointLayers!="object"||!(Number.isFinite(e.pointLayers.readScale)&&e.pointLayers.readScale>=1)||typeof e.pointLayers.readEveryLevel!="boolean")throw new TypeError(`${t}.pointLayers must be {readScale >= 1, readEveryLevel}.`);if(Ee(e.normTransform,Za,`${t}.normTransform`),!Array.isArray(e.normTransform.center)||e.normTransform.center.length!==3)throw new TypeError(`${t}.normTransform.center must be a three-number array.`);e.normTransform.center.forEach((r,n)=>{Ye(r,`${t}.normTransform.center[${n}]`)}),Ye(e.normTransform.scale,`${t}.normTransform.scale`,Number.MIN_VALUE)}a(li,"assertScientificState");function fi(e,o){if(io(e,"Figure export payload.meta"),!Array.isArray(e.views)||e.views.length!==o.length)throw new TypeError("Figure export payload.meta.views must publish one record per exported view.");e.views.forEach((t,r)=>{let n=`Figure export payload.meta.views[${r}]`;Ee(t,Va,n);let i=o[r];if(t.id!==i.id||t.label!==i.label)throw new Error(`${n} must describe the exported view "${i.id}".`);let s=i.scientificState;if(t.fieldKey!==s.fieldKey||t.fieldKind!==s.fieldKind)throw new Error(`${n} must name the field its view was coloured by.`);if(!Array.isArray(t.filters)||t.filters.length!==s.filters.length||t.filters.some((h,c)=>h!==s.filters[c]))throw new Error(`${n} must publish exactly its view's filters.`)})}a(fi,"assertMetaProvenance");function ui(e,o){Ee(e,xn,o);let t={...e,exportAllViews:!1};gn(t,o)}a(ui,"assertPayloadOptions");function sc(e){if(Ee(e,Ga,"Figure export payload"),mo(e.format,"Figure export payload.format"),ke(e.width,"Figure export payload.width",10),ke(e.height,"Figure export payload.height",10),e.format==="png")ke(e.dpi,"Figure export payload.dpi",72);else if(e.dpi!==null)throw new TypeError("Figure export payload.dpi must be null for SVG export.");if(vt(e.title,"Figure export payload.title"),ui(e.options,"Figure export payload.options"),Vo(e.options,e.format==="svg","Figure export payload.options"),!Array.isArray(e.views)||e.views.length===0)throw new TypeError("Figure export payload.views must be a non-empty array.");let o=e.views[0]?.data?.pointCount;ke(o,"Figure export payload point count",0),ci(e.selection,o,"Figure export payload.selection");let t=new Set;return e.views.forEach((r,n)=>{let i=`Figure export payload.views[${n}]`;if(Ee(r,Xa,i),ni(r.id,`${i}.id`),vt(r.label,`${i}.label`,{allowEmpty:!1}),t.has(r.id))throw new Error(`Figure export payload contains duplicate view "${r.id}".`);if(t.add(r.id),si(r.data,r.scientificState?.dimensionLevel,`${i}.data`),r.data.pointCount!==o)throw new RangeError(`${i}.data.pointCount must match every exported view.`);ii(r.renderState,`${i}.renderState`),gt(r.cameraState,`${i}.cameraState`),li(r.scientificState,r.data,`${i}.scientificState`)}),fi(e.meta,e.views),e}a(sc,"assertFigureExportPayload");function cc(e,o){mo(o,"Figure export payload format");let t={};for(let r of xn)t[r]=e[r];return o==="png"&&(t.strategy=null,t.optimizedTargetCount=null),Object.freeze(t)}a(cc,"createFigureExportPayloadOptions");function di(e){return!Number.isFinite(e)||e<0?0:e>1?1:e}a(di,"clamp01");function Zo(e){return Math.max(0,Math.min(255,Math.round(di(e)*255))).toString(16).padStart(2,"0")}a(Zo,"toHexByte");function ct(e){return!e||e.length<3?null:`#${Zo(e[0])}${Zo(e[1])}${Zo(e[2])}`}a(ct,"rgb01ToHex");function $t(e){let t=String(e||"").trim().match(/^#?([0-9a-fA-F]{6})$/);if(!t)return null;let r=t[1],n=parseInt(r.slice(0,2),16),i=parseInt(r.slice(2,4),16),s=parseInt(r.slice(4,6),16);return!Number.isFinite(n)||!Number.isFinite(i)||!Number.isFinite(s)?null:[n/255,i/255,s/255]}a($t,"hexToRgb01");var qo=Object.freeze([.2126,.7152,.0722]),hi=.5,bt=Object.freeze({scheme:"light",text:"#111111",mutedText:"#6b7280",frame:"#e5e7eb",surface:"#ffffff",surfaceInk:"#111111",halo:"#ffffff"}),pi=Object.freeze({scheme:"dark",text:"#f3f4f6",mutedText:"#9ca3af",frame:"#374151",surface:"#111827",surfaceInk:"#f3f4f6",halo:"#111827"});function pc({background:e,backgroundColor:o}){if(e==="transparent")return bt;let t=$t(o);if(t===null)throw new TypeError("Figure ink requires an exact #RRGGBB background colour.");return t[0]*qo[0]+t[1]*qo[1]+t[2]*qo[2]>=hi?bt:pi}a(pc,"resolveFigureInk");function vn(e,o){let t=[[e,o]];for(;t.length>0;){let[r,n]=t.pop();if(r===n)continue;if(r===null||n===null||typeof r!="object"||typeof n!="object")return!1;let i=r instanceof Uint8Array;if(i!==n instanceof Uint8Array)return!1;if(i){if(r.length!==n.length)return!1;for(let f=0;f<r.length;f++)if(r[f]!==n[f])return!1;continue}let s=Array.isArray(r);if(s!==Array.isArray(n))return!1;if(s){if(r.length!==n.length)return!1;for(let f=0;f<r.length;f++)t.push([r[f],n[f]]);continue}let h=Object.keys(r),c=Object.keys(n);if(h.length!==c.length)return!1;for(let f of h){if(!Object.prototype.hasOwnProperty.call(n,f))return!1;t.push([r[f],n[f]])}}return!0}a(vn,"areLegendModelsSemanticallyEqual");var bo=" (hidden)",En=4;function _n(e,o,t){let r=[],n="";for(let i of e.split(" ")){let s=n===""?i:`${n} ${i}`;n!==""&&t(s)>o?(r.push(n),n=i):n=s}return n!==""&&r.push(n),r}a(_n,"noteLines");var An=1.25;function Mn(e){let o=Array.isArray(e)?e:[],t=Math.max(1,o.length-1);return o.map((r,n)=>{let i=String(r??"").trim(),s=/^(.*\S)\s+(-?\d+(?:\.\d+)?)%$/.exec(i),h=s===null?n/t:Number(s[2])/100;return{color:s===null?i:s[1],offset:Math.min(1,Math.max(0,h))}}).filter(r=>r.color!=="")}a(Mn,"colorBarStops");function Jo(e,o){return String(e??"").length*o*.62}a(Jo,"estimateTextWidthPxApprox");function mi(e,o,t){let r=String(e??"");if(o<=0)return"";if(Jo(r,t)<=o)return r;let n="…",i=Math.max(1e-4,t*.62),s=Math.max(0,Math.floor(o/i)-1);return s<=0?n:r.slice(0,s)+n}a(mi,"truncateTextApprox");function bi(e,o,t){let r=String(o??"");if(t<=0)return"";if(e.measureText(r).width<=t)return r;let n="…";if(e.measureText(n).width>t)return"";let i=0,s=r.length;for(;i<s;){let h=Math.ceil((i+s)/2),c=r.slice(0,h)+n;e.measureText(c).width<=t?i=h:s=h-1}return r.slice(0,i)+n}a(bi,"truncateCanvasTextToWidth");function xo(e,o){let t=e?.visible;if(t instanceof Uint8Array&&t[o]===0)return!0;let r=e?.counts?.available;return Array.isArray(r)&&r[o]===0}a(xo,"isCategoryHidden");function Tn({name:e,hidden:o,maxWidthPx:t,fit:r,measure:n}){let i=String(e??"");if(!o)return r(i,t);let s=t-n(bo);return`${r(i,s)}${bo}`}a(Tn,"composeCategoryLabel");function xi(e){return e?.logEnabled===!0||e?.scale==="log"||e?.colorbar?.scale==="log"}a(xi,"isLogColorScale");function Sn(e,o,t){let r=e?.geneSample??null,n=e?.zeroGray?.drawn===!0,i=r!==null?`${Wr(r)}. ${Hr(n)}`:n?"Gray: 0":null,s=[yi(e,o,t),i].filter(h=>h!==null);return s.length===0?null:s.join(" · ")}a(Sn,"buildColorScaleNote");function yi(e,o,t){if(!xi(e))return e?.colorbar?.centered===!0?"Color scale centred at 0":null;let r=Number(o),n=Number(t);return Number.isFinite(r)&&Number.isFinite(n)&&r>0&&n>0?`Log10 color scale (midpoint ${ht(Math.sqrt(r*n))})`:"Log10 color scale"}a(yi,"scaleNote");function Mc(e){let o=null,t=null;for(let r of e){let n=r.scientificState.fieldKey,i=r.scientificState.legendModel;if(n===null||i===null)return null;if(o===null){o=n,t=i;continue}if(o!==n||!vn(t,i))return null}return o===null||t===null?null:{fieldKey:o,model:t}}a(Mc,"resolveSharedGridLegend");function Tc({legendRect:e,fieldKey:o,model:t,fontFamily:r="Arial, Helvetica, sans-serif",fontSize:n=12,idPrefix:i="legend",backgroundFill:s="#ffffff",ink:h=bt}){let c=h.mutedText,f=h.text,d=h.mutedText;if(!e||!t)return{svg:"",defs:""};let l=e.x,m=e.y,w=e.width,y=e.height,x=8,S=Math.max(14,Math.round(n*1.2)),A=[],g=[];A.push(`<g font-family="${xe(r)}" font-size="${n}" fill="${h.text}">`);let _=s==="transparent"?"none":s;A.push(`<rect x="${l}" y="${m}" width="${w}" height="${y}" fill="${xe(_)}" stroke="${h.frame}" stroke-width="1"/>`);let k=o?String(o):t.kind==="continuous"?"Color scale":"Legend";A.push(`<text x="${l+x}" y="${m+x+n}" font-weight="600">${xe(k)}</text>`);let v=m+x+n+8;if(t.kind==="category"){let z=t.categories||[],F=t.colors,L=10,R=v,C=m+y-x,P=Math.max(1,C-R),D=Math.max(1,Math.floor(P/S)),B=Math.max(1,Math.ceil(z.length/D)),I=Math.max(1,(w-x*2)/B);for(let $=0;$<z.length;$++){let U=Math.floor($/D),X=$%D,ne=l+x+U*I,ye=R+X*S,V=ne+L+6,le=l+x+(U+1)*I,be=Math.max(0,le-V-2),ze=xo(t,$),He=Tn({name:z[$],hidden:ze,maxWidthPx:be,fit:a((Ne,Ie)=>mi(Ne,Ie,n),"fit"),measure:a(Ne=>Jo(Ne,n),"measure")});ze?A.push(`<rect x="${ne}" y="${ye}" width="${L}" height="${L}" fill="none" stroke="${c}" stroke-width="1"/>`):A.push(`<rect x="${ne}" y="${ye}" width="${L}" height="${L}" fill="${Lo(F,$)}" stroke="${f}" stroke-width="0.25"/>`),A.push(`<text x="${V}" y="${ye+L}" fill="${ze?c:f}" dominant-baseline="ideographic">${xe(He)}</text>`)}}else if(t.kind==="continuous"){let z=`${i}_grad`,F=Mn(t.colorStops);g.push(`<linearGradient id="${z}" x1="0" x2="1" y1="0" y2="0">`);for(let $ of F)g.push(`<stop offset="${+($.offset*100).toFixed(3)}%" stop-color="${$.color}"/>`);g.push("</linearGradient>");let L=12,R=Math.max(40,w-x*2);A.push(`<rect x="${l+x}" y="${v}" width="${R}" height="${L}" fill="url(#${z})" stroke="${h.text}" stroke-width="0.5"/>`),v+=L+6;let C=t.colorbar?.min??t.stats?.min,P=t.colorbar?.max??t.stats?.max,D=ht(Number(C)),B=ht(Number(P));A.push(`<text x="${l+x}" y="${v+n}" fill="${d}">${D}</text>`),A.push(`<text x="${l+x+R}" y="${v+n}" text-anchor="end" fill="${d}">${B}</text>`);let I=Sn(t,C,P);if(I!==null){let $=v+n*2+En;_n(I,R,U=>Jo(U,n)).forEach((U,X)=>{A.push(`<text x="${l+x}" y="${$+X*n*An}" fill="${d}">${xe(U)}</text>`)})}}return A.push("</g>"),{svg:A.join(""),defs:g.length?`<defs>${g.join("")}</defs>`:""}}a(Tc,"renderSvgLegend");function Sc({ctx:e,legendRect:o,fieldKey:t,model:r,fontFamily:n="Arial, Helvetica, sans-serif",fontSize:i=12,backgroundFill:s="#ffffff",ink:h=bt}){let c=h.mutedText,f=h.text,d=h.mutedText;if(!e||!o||!r)return;let l=o.x,m=o.y,w=o.width,y=o.height,x=8,S=Math.max(14,Math.round(i*1.2));e.save(),s!=="transparent"&&(e.fillStyle=s,e.fillRect(l,m,w,y)),e.strokeStyle=h.frame,e.lineWidth=1,e.strokeRect(l,m,w,y),e.fillStyle=h.text,e.font=`600 ${i}px ${n}`,e.textAlign="left",e.textBaseline="alphabetic";let A=t?String(t):r.kind==="continuous"?"Color scale":"Legend";e.fillText(A,l+x,m+x+i);let g=m+x+i+8;if(e.font=`${i}px ${n}`,r.kind==="category"){let _=r.categories||[],k=r.colors,v=10,z=g,F=m+y-x,L=Math.max(1,F-z),R=Math.max(1,Math.floor(L/S)),C=Math.max(1,Math.ceil(_.length/R)),P=Math.max(1,(w-x*2)/C);e.save(),e.beginPath(),e.rect(l,m,w,y),e.clip();for(let D=0;D<_.length;D++){let B=Math.floor(D/R),I=D%R,$=l+x+B*P,U=z+I*S,X=$+v+6,ne=l+x+(B+1)*P,ye=Math.max(0,ne-X-2),V=xo(r,D);V?(e.strokeStyle=c,e.lineWidth=1,e.strokeRect($,U,v,v)):(e.fillStyle=Lo(k,D),e.fillRect($,U,v,v),e.strokeStyle=f,e.lineWidth=.5,e.strokeRect($,U,v,v)),e.fillStyle=V?c:f;let le=Tn({name:_[D],hidden:V,maxWidthPx:ye,fit:a((be,ze)=>bi(e,be,ze),"fit"),measure:a(be=>e.measureText(be).width,"measure")});e.fillText(le,X,U+v)}e.restore()}else if(r.kind==="continuous"){let k=Math.max(40,w-x*2),v=e.createLinearGradient(l+x,0,l+x+k,0);for(let R of Mn(r.colorStops))v.addColorStop(R.offset,R.color);e.fillStyle=v,e.fillRect(l+x,g,k,12),e.strokeStyle=h.text,e.lineWidth=.5,e.strokeRect(l+x,g,k,12),g+=18;let z=r.colorbar?.min??r.stats?.min,F=r.colorbar?.max??r.stats?.max;e.fillStyle=d,e.textAlign="left",e.fillText(ht(Number(z)),l+x,g+i),e.textAlign="right",e.fillText(ht(Number(F)),l+x+k,g+i);let L=Sn(r,z,F);L!==null&&(e.textAlign="left",_n(L,k,R=>e.measureText(R).width).forEach((R,C)=>{e.fillText(R,l+x,g+i*2+En+C*i*An)}))}e.restore()}a(Sc,"drawCanvasLegend");var gi=new Set([1,2,3]),wi=new Set(["points","smoke"]);function kn(e){if(!gi.has(e))throw new RangeError(`Camera dimension must be exactly 1, 2, or 3; received ${String(e)}.`);return e===3?"orbit":"planar"}a(kn,"getDefaultNavigationMode");function yo(e){if(typeof e!="string"||e.length===0)throw new TypeError("Renderer view id must be a non-empty string.");return e}a(yo,"assertViewId");function Qo(e,o){if(typeof e!="boolean")throw new TypeError(`${o} state must be an exact boolean.`);return e}a(Qo,"assertExactBoolean");function Nc(e,o,t,r){if(typeof e!="number"||!Number.isFinite(e))throw new TypeError(`${r} must be one finite number.`);if(e<o||e>t)throw new RangeError(`${r} must be between ${o} and ${t}.`);return e}a(Nc,"assertFiniteNumberInRange");function Ic(e,o,t,r){if(!Number.isSafeInteger(e))throw new TypeError(`${r} must be one safe integer.`);if(e<o||e>t)throw new RangeError(`${r} must be between ${o} and ${t}.`);return e}a(Ic,"assertIntegerInRange");function er(e,o){if(typeof e!="function")throw new TypeError(`${o} must be one function.`);return e}a(er,"assertExactFunction");function Rn(e,o){if(typeof e!="string"||e.length===0||e!==e.trim())throw new TypeError(`${o} must be one non-empty string without leading or trailing whitespace.`);return e}a(Rn,"assertNonEmptyTrimmedString");function Cn(e,o,t){if(!(e instanceof Float32Array))throw new TypeError(`${t} must be a Float32Array.`);if(e.length!==o)throw new RangeError(`${t} must contain exactly ${$o(o,"value")}; received ${e.length}.`);return e}a(Cn,"assertExactFloat32Array");function $n(e,o,t){let r=Cn(e,o,t);if(Gr(r))return r;for(let n=0;n<r.length;n+=1)if(!Number.isFinite(r[n]))throw new RangeError(`${t} value ${n} must be finite.`);return Xr(r),r}a($n,"assertFiniteFloat32Array");function vi(e,o,t,r){let n=Cn(e,o,r);return Pr(n)?n:zr(n,t,r)}a(vi,"assertCellPositions");function Xt(e,o,t){if(!(e instanceof Uint8Array))throw new TypeError(`${t} must be a Uint8Array.`);if(e.length!==o)throw new RangeError(`${t} must contain exactly ${$o(o,"byte")}; received ${e.length}.`);return e}a(Xt,"assertExactUint8Array");function On(e,o,t){let r=Xt(e,o,t),n=Dr(r);if(n>=0)throw new RangeError(`${t} value ${n} must be exactly 0 or 1.`);return r}a(On,"assertTransparencyArray");function Ei(e,o){if(e!==null&&(typeof e!="string"||e.length===0))throw new TypeError(`${o} layoutKey must be a non-empty string or exact null.`);return e}a(Ei,"assertViewLayoutKey");function Dc(e){let o=Ee(e,["positions","colors","transparency","dimensionLevel","layoutKey"],"Viewer data"),t=o.dimensionLevel;kn(t);let r=Ei(o.layoutKey,"Viewer data");if(r===null&&o.positions?.length!==0)throw new TypeError("Viewer data with points must name the layout its positions belong to.");if(!(o.positions instanceof Float32Array)||o.positions.length%t!==0)throw new TypeError("Viewer positions must be a Float32Array with exactly dimensionLevel values per point.");let n=o.positions.length/t;return vi(o.positions,n*t,t,"Viewer positions"),Xt(o.colors,n*4,"Viewer colors"),On(o.transparency,n,"Viewer transparency"),{positions:o.positions,colors:o.colors,transparency:o.transparency,dimensionLevel:t,layoutKey:r,pointCount:n}}a(Dc,"assertViewerDataPayload");function Bc(e){let o=Ee(e,["positions","colors"],"Centroid data");if(!(o.positions instanceof Float32Array)||o.positions.length%3!==0)throw new TypeError("Centroid positions must be a Float32Array with exactly three values per centroid.");let t=o.positions.length/3;return $n(o.positions,t*3,"Centroid positions"),Xt(o.colors,t*4,"Centroid colors"),{positions:o.positions,colors:o.colors,count:t}}a(Bc,"assertCentroidPayload");function _i(e,o="Snapshot metadata"){let t=Ee(e,["filtersText"],o);if(!Array.isArray(t.filtersText)||t.filtersText.some(r=>typeof r!="string"||r.length===0||r.trim()!==r))throw new TypeError(`${o} filtersText must be an array of non-empty trimmed strings.`);return{filtersText:[...t.filtersText]}}a(_i,"cloneSnapshotMeta");function Ai(e,o){if(e===null||o===null){if(e!==null||o!==null)throw new TypeError("Snapshot fieldKey and fieldKind must both be null or both be present.");return}if(Rn(e,"Snapshot field key"),o!=="category"&&o!=="continuous")throw new RangeError('Snapshot field kind must be exactly "category", "continuous", or null.')}a(Ai,"assertSnapshotFieldDescriptor");function Uc(e,o){let t=Ee(e,["cameraState","centroidColors","centroidPositions","colors","dimensionLevel","fieldKey","fieldKind","label","meta","sourceViewId","transparency"],"Snapshot configuration");Rn(t.label,"Snapshot label"),Ai(t.fieldKey,t.fieldKind),Xt(t.colors,o*4,"Snapshot colors"),On(t.transparency,o,"Snapshot transparency");let r=[t.centroidPositions,t.centroidColors],n=r.every(c=>c===null);if(!n&&r.some(c=>c===null))throw new TypeError("Snapshot centroid positions and colors must be published together.");let i=0;if(!n){if(!(t.centroidPositions instanceof Float32Array)||t.centroidPositions.length%3!==0)throw new TypeError("Snapshot centroid positions must contain complete Float32 XYZ triples.");i=t.centroidPositions.length/3,$n(t.centroidPositions,i*3,"Snapshot centroid positions"),Xt(t.centroidColors,i*4,"Snapshot centroid colors")}let s=t.dimensionLevel;kn(s);let h=co(t.cameraState,"Snapshot camera state");return{label:t.label,fieldKey:t.fieldKey,fieldKind:t.fieldKind,colors:t.colors,transparency:new Uint8Array(t.transparency),centroidPositions:n?null:new Float32Array(t.centroidPositions),centroidColors:n?null:new Uint8Array(t.centroidColors),centroidCount:i,meta:_i(t.meta),cameraState:h,dimensionLevel:s}}a(Uc,"assertSnapshotConfig");function jc(e){if(!Array.isArray(e))throw new TypeError("Centroid labels must be an array.");for(let[o,t]of e.entries()){let r=t!==null&&typeof t=="object"&&!Array.isArray(t)?Object.keys(t).sort().join(","):"",n=r==="alpha,el,position";if(t===null||typeof t!="object"||Array.isArray(t)||Object.getPrototypeOf(t)!==Object.prototype||r!=="el,position"&&!n||!(t.el instanceof HTMLElement)||!Array.isArray(t.position)||t.position.length!==3||!t.position.every(i=>typeof i=="number"&&Number.isFinite(i))||n&&(typeof t.alpha!="number"||!Number.isFinite(t.alpha)||t.alpha<0||t.alpha>1))throw new TypeError(`Centroid label ${o} must be an exact element/finite-3D-position record with optional finite alpha from 0 through 1.`)}return e}a(jc,"assertCentroidLabelEntries");function Gc(e){if(!ho(e))throw new TypeError(cn);return e}a(Gc,"assertViewerBackground");function Xc(e){if(!wi.has(e))throw new TypeError('Render mode must be exactly "points" or "smoke".');return e}a(Xc,"assertRenderMode");function Vc(e,o,t){let r=er(e,"Borrowed-view-data callback"),n=er(t,"Borrowed-view-data validator"),i,s=!1,h;try{i=r(o)}catch(d){s=!0,h=d}if(s){try{n()}catch(d){throw new AggregateError([h,d],"Borrowed-view-data callback failed while its ownership also changed.")}throw h}let c=null;try{i!==null&&(typeof i=="object"||typeof i=="function")&&typeof i.then=="function"&&(c=new TypeError("Borrowed-view-data callback must complete synchronously and must not return a Promise or thenable."))}catch(d){c=d}let f=null;try{n()}catch(d){f=d}if(c!==null&&f!==null)throw new AggregateError([c,f],"Borrowed-view-data result failed while its ownership also changed.");if(f!==null)throw f;if(c!==null)throw c;return i}a(Vc,"runSynchronousBorrowedViewDataCallback");function Fn(e,o){if(typeof e!="number"||!Number.isFinite(e)||e<=0)throw new TypeError(`${o} must be one positive finite number.`);return e}a(Fn,"assertPositiveFinite");function tr(e){if(!Number.isSafeInteger(e)||e<=0)throw new RangeError("Presented grid view count must be a positive safe integer.");return e<=3?e:Math.ceil(Math.sqrt(e))}a(tr,"getPresentedGridColumns");function Zc(e){if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError("Presented layout requires one exact options object.");let{canvasHeight:o,canvasWidth:t,focusedViewId:r,mode:n,viewIds:i}=e;if(!Number.isSafeInteger(t)||t<=0||!Number.isSafeInteger(o)||o<=0)throw new TypeError("Presented-view canvas dimensions must be positive safe integers.");let s=Fn(e.cssWidth,"Presented CSS width"),h=Fn(e.cssHeight,"Presented CSS height"),c=e.leftOcclusionRatio;if(typeof c!="number"||!(c>=0&&c<=1))throw new RangeError("Presented left occlusion ratio must be a number between 0 and 1.");if(n!=="single"&&n!=="grid")throw new TypeError('Presented-view layout mode must be exactly "single" or "grid".');let f=yo(r);if(!Array.isArray(i)||i.length===0||i.some(_=>typeof _!="string"||_.length===0)||new Set(i).size!==i.length)throw new TypeError("Presented-view inventory must contain unique non-empty view IDs.");let d=s/t,l=h/o,m=i.length,w=n==="grid"&&m>1,y=w?tr(m):1,x=w?Math.ceil(m/y):1,S=t-y;if(S<0||o<x)throw new RangeError("Presented-view grid panes must have positive framebuffer dimensions.");let A=[],g;if(w){let _=Math.min(S,Math.max(0,Math.ceil(c*t-1e-6)));g=_*d;let k=Math.floor((t-_)/y),v=Math.floor(o/x);for(let z=0;z<m;z+=1){let F=z%y,L=Math.floor(z/y),R=_+F*k,C=L*v,P=R*d,D=C*l,B=k*d,I=v*l;A.push(Object.freeze({col:F,cssHeight:I,cssLeft:P,cssTop:D,cssWidth:B,projectionCenterNdcX:0,row:L,scissorEnabled:!0,viewId:i[z],viewIndex:z,viewportHeight:v,viewportWidth:k,viewportX:R,viewportY:o-C-v,visibleCssHeight:I,visibleCssLeft:P,visibleCssTop:D,visibleCssWidth:B}))}}else{let _=i.indexOf(f);if(_<0)throw new RangeError(`Focused view "${f}" is absent from the presented render inventory.`);let k=Math.min(c,S/t);g=k*s,A.push(Object.freeze({col:0,cssHeight:h,cssLeft:0,cssTop:0,cssWidth:s,projectionCenterNdcX:k,row:0,scissorEnabled:!1,viewId:f,viewIndex:_,viewportHeight:o,viewportWidth:t,viewportX:0,viewportY:0,visibleCssHeight:h,visibleCssLeft:g,visibleCssTop:0,visibleCssWidth:s-g}))}return Object.freeze({canvasHeight:o,canvasWidth:t,cols:y,cssHeight:h,cssWidth:s,gridMultiview:w,layoutMode:n,leftOcclusionRatio:c,panes:Object.freeze(A),presentedArea:Object.freeze({cssHeight:h,cssLeft:g,cssTop:0,cssWidth:s-g}),rows:x,viewCount:m})}a(Zc,"resolvePresentedLayout");function qc(e,o){let t=yo(o);if(e===null||typeof e!="object"||!Array.isArray(e.panes))throw new TypeError("Presented pane lookup requires one resolved layout.");for(let r of e.panes)if(r.viewId===t)return r;throw new RangeError(`View "${t}" is not presented in the current ${e.layoutMode} layout.`)}a(qc,"getPresentedPane");function Jc(e,o,t){if(!Number.isFinite(o)||!Number.isFinite(t))throw new TypeError("Presented pane hit testing requires a finite point.");if(!e.gridMultiview)return e.panes[0];let r=e.panes[0],n=Math.max(0,Math.min(e.cols-1,Math.floor((o-r.cssLeft)/r.cssWidth))),i=Math.max(0,Math.min(e.rows-1,Math.floor(t/r.cssHeight)));return e.panes[i*e.cols+n]??null}a(Jc,"getPresentedPaneAtCssPoint");function Qc(e){if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError("Presented-view camera selection requires one exact options object.");let o=yo(e.viewId),t=Qo(e.followsFocusedCamera,"Presented-view camera following"),i=Qo(e.gridMultiview,"Presented-view grid ownership")&&!t?e.storedCameraState:e.globalCameraState;return co(i,`Presented camera state for view "${o}"`)}a(Qc,"selectPresentedCameraState");var et=20,go=34,Wt=16,ar=240,ir=140,Ot=8,Ln=10,Pn=6,zn=2,Nn=.62,wo=62,sr=62,cr=10,lr=10,Et=10,Ht=8,or=96,rr=44,nr=.5;function In(e){let o=e.categories||[],t=0;for(let r=0;r<o.length;r++){let n=String(o[r]??"").length+(xo(e,r)?bo.length:0);n>t&&(t=n)}return t}a(In,"longestCategoryEntryLength");function Dn({model:e,fontSizePx:o,plotHeight:t,minimumWidth:r=ar}){if(!e||e.kind!=="category")return r;let n=e.categories||[];if(!n.length)return r;let i=Math.max(14,Math.round(o*1.2)),s=Ot+o+8,h=Math.max(1,t-s-Ot),c=Math.max(1,Math.floor(h/i)),f=Math.max(1,Math.ceil(n.length/c)),d=In(e)*o*Nn,l=Ln+Pn+d+zn,m=Math.ceil(Ot*2+f*l);return Math.max(r,m)}a(Dn,"estimateLegendWidthRight");function Bn({model:e,fontSizePx:o,plotWidth:t,minimumHeight:r=ir}){if(!e||e.kind!=="category")return r;let n=e.categories||[];if(!n.length)return r;let i=In(e)*o*Nn,s=Ln+Pn+i+zn,h=Math.max(14,Math.round(o*1.2)),c=Ot+o+8,f=Math.max(1,t-Ot*2),d=Math.max(1,Math.floor(f/Math.max(1,s))),l=Math.max(1,Math.ceil(n.length/d)),m=Math.ceil(c+l*h+Ot);return Math.max(r,m)}a(Bn,"estimateLegendHeightBottom");function Mi({desiredPlotWidth:e,desiredPlotHeight:o,hasTitle:t=!1,includeAxes:r=!0,includeLegend:n=!0,legendPosition:i="right",legendModel:s=null,legendFontSizePx:h=12}){let c=Math.max(1,Math.round(e)),f=Math.max(1,Math.round(o)),d=Math.max(6,Math.round(Number(h)||12)),l=r?wo:Et,m=r?lr:Et,w=r?cr:Et,y=r?sr:Et,x=n&&i==="right"?Math.min(c,Dn({model:s,fontSizePx:d,plotHeight:f})):0,S=n&&i==="bottom"?Math.min(f,Bn({model:s,fontSizePx:d,plotWidth:c})):0,A=x>0?Wt:0,g=S>0?Wt:0,_=t?go:0,k=et+l+c+m+A+x+et,v=et+_+w+f+y+g+S+et;return{totalWidth:k,totalHeight:v,plotWidth:c,plotHeight:f,legendWidth:x,legendHeight:S}}a(Mi,"computeExpandedDimensions");function al({width:e,height:o,title:t="",includeAxes:r=!0,includeLegend:n=!0,legendPosition:i="right",legendModel:s=null,legendFontSizePx:h=12}){let c=!!String(t||"").trim(),f=Math.max(1,Math.round(e)),d=Math.max(1,Math.round(o)),l=Mi({desiredPlotWidth:f,desiredPlotHeight:d,hasTitle:c,includeAxes:r,includeLegend:n,legendPosition:i,legendModel:s,legendFontSizePx:h}),m=r?wo:Et,w=r?cr:Et,y=c?go:0,x={x:et+m,y:et+y+w,width:f,height:d},S=n?i==="right"?{x:x.x+x.width+Wt,y:x.y,width:l.legendWidth,height:x.height}:{x:x.x,y:x.y+x.height+Wt,width:x.width,height:l.legendHeight}:null,A=l.totalWidth-et*2,g=c?{x:et,y:et,width:A,height:go}:null;return{outerPadding:et,totalWidth:l.totalWidth,totalHeight:l.totalHeight,titleRect:g,plotRect:x,legendRect:S}}a(al,"computeSingleViewLayout");function il({cellX:e,cellY:o,cellWidth:t,cellHeight:r,includeAxes:n,fontSize:i,legendModel:s=null,legendPosition:h="right",legendFontSizePx:c=12}){let f=Me(Math.round(i*.65),6,12),d=Math.max(1,t-f*2),l=Math.max(1,r-f*2),m=Math.min(Math.max(18,Math.round(i*1.5)),Math.max(0,l-1)),w=Math.max(1,l-m),y=Math.max(6,Math.round(Number(c)||12)),x=null,S=0,A=0;if(s!==null)if(h==="right"){let C=Math.floor(d*nr)-Ht;if(C>=or){let P=Math.min(C,Math.min(ar,Dn({model:s,fontSizePx:y,plotHeight:w,minimumWidth:or})));S=P+Ht,x={x:e+f+d-P,y:o+f+m,width:P,height:w}}}else{let C=Math.floor(w*nr)-Ht;if(C>=rr){let P=Math.min(C,Math.min(ir,Bn({model:s,fontSizePx:y,plotWidth:d,minimumHeight:rr})));A=P+Ht,x={x:e+f,y:o+f+l-P,width:d,height:P}}}let g=Math.max(1,d-S),_=Math.max(1,w-A),k=Math.min(80,Math.max(1,g*.45)),v=Math.min(64,Math.max(1,_*.45)),z=n?Math.min(lr,Math.max(0,g-k)):0,F=n?Math.min(wo,Math.max(0,g-z-k)):0,L=n?Math.min(sr,Math.max(0,_-v)):0,R={x:e+f+F,y:o+f+m,width:Math.max(1,g-F-z),height:Math.max(1,_-L)};return{labelX:R.x,labelY:o+f+Math.min(i,Math.max(1,m)),panelRect:{x:e+1,y:o+1,width:Math.max(1,t-2),height:Math.max(1,r-2)},plotRect:R,legendRect:x}}a(il,"computeGridPaneLayout");function sl(e){let o=Math.max(1,e),t=tr(o);return{cols:t,rows:Math.ceil(o/t)}}a(sl,"computeGridDims");var cl={OUTER_PADDING:et,TITLE_HEIGHT:go,LEGEND_GAP:Wt,LEGEND_WIDTH_RIGHT:ar,LEGEND_HEIGHT_BOTTOM:ir,AXIS_LEFT_SPACE:wo,AXIS_BOTTOM_SPACE:sr,AXIS_TOP_SPACE:cr,AXIS_RIGHT_SPACE:lr,NO_AXIS_PADDING:Et,PANEL_LEGEND_GAP:Ht,PANEL_LEGEND_MIN_WIDTH:or,PANEL_LEGEND_MIN_HEIGHT:rr,PANEL_LEGEND_MAX_SHARE:nr};function Un(e){return+`1e${e}`}a(Un,"powerOfTen");function fr(e,o,t=5){let r=Number(e),n=Number(o);if(!Number.isFinite(r)||!Number.isFinite(n))return{ticks:[0],niceMin:0,niceMax:0,step:1};if(r===n){let A=r===0?1:Un(Math.floor(Math.log10(Math.abs(r))));return{ticks:[r],niceMin:r,niceMax:r,step:A}}let i=Math.min(r,n),s=Math.max(r,n),c=(s-i)/Math.max(1,t),f=Un(Math.floor(Math.log10(Math.abs(c)))),d=c/f,l;d<=1?l=1*f:d<=2?l=2*f:d<=5?l=5*f:l=10*f;let m=Math.floor(i/l)*l,w=Math.ceil(s/l)*l,y=[],x=2048,S=m;for(let A=0;A<x&&S<=w+l*.5;A++)y.push(+S.toFixed(12)),S+=l;return{ticks:y,niceMin:m,niceMax:w,step:l}}a(fr,"niceNumbers");function jn({ticks:e,step:o}){let t=0;for(let n of e)t=Math.max(t,Math.abs(n));let r=Lr(t,o);return e.map(n=>ht(n,r))}a(jn,"tickLabels");function Gn(e,o=5){let t=fr(e.minX,e.maxX,o),r=fr(e.minY,e.maxY,o);return{xTicks:t.ticks,yTicks:r.ticks,xLabels:jn(t),yLabels:jn(r),xNice:{min:t.niceMin,max:t.niceMax},yNice:{min:r.niceMin,max:r.niceMax}}}a(Gn,"buildAxesModel");function bl({plotRect:e,bounds:o,xLabel:t="X",yLabel:r="Y",fontFamily:n="Arial, Helvetica, sans-serif",tickFontSize:i=null,labelFontSize:s=null,axisGapPx:h=6,color:c="#111"}){let f=Math.max(6,Math.round(Number(i)||12)),d=Number.isFinite(s)?Math.max(6,Math.round(s)):f,l=Gn(o,5),m=c,w=Math.max(0,Math.round(Number(h)||0)),y=5,x=Math.max(12,Math.round(d*1.15)),S=8,A=String(t??"").trim(),g=String(r??"").trim(),_=e.x,k=e.x+e.width,v=e.y,z=e.y+e.height,F=_-w,L=z+w,R=[];R.push(`<g font-family="${xe(n)}" font-size="${f}" fill="${xe(m)}" stroke="${xe(m)}" stroke-width="1">`),R.push(`<line x1="${_}" y1="${L}" x2="${k}" y2="${L}"/>`),R.push(`<line x1="${F}" y1="${v}" x2="${F}" y2="${z}"/>`);let C=l.xNice.max-l.xNice.min||1;l.xTicks.forEach((D,B)=>{let I=(D-l.xNice.min)/C,$=_+I*e.width;R.push(`<line x1="${$}" y1="${L}" x2="${$}" y2="${L+y}"/>`),R.push(`<text x="${$}" y="${L+y+S}" text-anchor="middle" stroke="none">${l.xLabels[B]}</text>`)});let P=l.yNice.max-l.yNice.min||1;if(l.yTicks.forEach((D,B)=>{let I=(D-l.yNice.min)/P,$=z-I*e.height;R.push(`<line x1="${F}" y1="${$}" x2="${F-y}" y2="${$}"/>`),R.push(`<text x="${F-y-S}" y="${$+4}" text-anchor="end" stroke="none">${l.yLabels[B]}</text>`)}),A&&R.push(`<text x="${(_+k)/2}" y="${L+y+S+x}" text-anchor="middle" stroke="none" font-size="${d}">${xe(A)}</text>`),g){let D=F-y-S-x,B=(v+z)/2;R.push(`<text x="${D}" y="${B}" text-anchor="middle" stroke="none" font-size="${d}" transform="rotate(-90 ${D} ${B})">${xe(g)}</text>`)}return R.push("</g>"),R.join("")}a(bl,"renderSvgAxes");function xl({ctx:e,plotRect:o,bounds:t,xLabel:r="X",yLabel:n="Y",fontFamily:i="Arial, Helvetica, sans-serif",tickFontSize:s=null,labelFontSize:h=null,axisGapPx:c=6,color:f="#111"}){let d=Math.max(6,Math.round(Number(s)||12)),l=Number.isFinite(h)?Math.max(6,Math.round(h)):d,m=Gn(t,5),w=Math.max(0,Math.round(Number(c)||0)),y=5,x=Math.max(12,Math.round(l*1.15)),S=8,A=String(r??"").trim(),g=String(n??"").trim(),_=o.x,k=o.x+o.width,v=o.y,z=o.y+o.height,F=_-w,L=z+w;e.save(),e.strokeStyle=f,e.fillStyle=f,e.lineWidth=1,e.font=`${d}px ${i}`,e.textBaseline="alphabetic",e.beginPath(),e.moveTo(_,L),e.lineTo(k,L),e.moveTo(F,v),e.lineTo(F,z),e.stroke();let R=m.xNice.max-m.xNice.min||1;m.xTicks.forEach((P,D)=>{let B=(P-m.xNice.min)/R,I=_+B*o.width;e.beginPath(),e.moveTo(I,L),e.lineTo(I,L+y),e.stroke(),e.textAlign="center",e.fillText(m.xLabels[D],I,L+y+S)});let C=m.yNice.max-m.yNice.min||1;m.yTicks.forEach((P,D)=>{let B=(P-m.yNice.min)/C,I=z-B*o.height;e.beginPath(),e.moveTo(F,I),e.lineTo(F-y,I),e.stroke(),e.textAlign="right",e.fillText(m.yLabels[D],F-y-2,I+4)}),(A||g)&&(e.font=`${l}px ${i}`,e.textAlign="center"),A&&e.fillText(A,(_+k)/2,L+y+S+x),g&&(e.save(),e.translate(F-y-S-x,(v+z)/2),e.rotate(-Math.PI/2),e.textAlign="center",e.fillText(g,0,0),e.restore()),e.restore()}a(xl,"drawCanvasAxes");function vo(e){return Number(e)*180/Math.PI}a(vo,"toDegrees");function Eo(e){let o=Number(e);if(!Number.isFinite(o))return 0;for(;o<=-180;)o+=360;for(;o>180;)o-=360;return o}a(Eo,"normalizeDegrees");function Ft(e,o){let t=e,r=o[0],n=o[1],i=o[2];return[t[0]*r+t[4]*n+t[8]*i,t[1]*r+t[5]*n+t[9]*i,t[2]*r+t[6]*n+t[10]*i]}a(Ft,"transformDirection");function Xn(e,o){return Math.sqrt(e*e+o*o)||1}a(Xn,"length2");function Ti(e,o,t,r,n,i){let s=Me(i,0,Math.min(r,n)/2);if(typeof e.roundRect=="function"){e.beginPath(),e.roundRect(o,t,r,n,s);return}e.beginPath(),e.moveTo(o+s,t),e.arcTo(o+r,t,o+r,t+n,s),e.arcTo(o+r,t+n,o,t+n,s),e.arcTo(o,t+n,o,t,s),e.arcTo(o,t,o+r,t,s),e.closePath()}a(Ti,"beginRoundRectPath");function Hn(e){let o=gt(e,"Orientation-indicator camera state"),t=o.navigationMode;if(t==="orbit"){let r=o.orbit.theta,n=o.orbit.phi,i=Eo(vo(r)),s=Me(Eo(90-vo(n)),-90,90);return[`az ${i.toFixed(0)}°`,`el ${s.toFixed(0)}°`]}if(t==="free"){let r=o.freefly.yaw,n=o.freefly.pitch,i=Eo(vo(r)),s=Me(Eo(vo(n)),-90,90);return[`yaw ${i.toFixed(0)}°`,`pit ${s.toFixed(0)}°`]}return[]}a(Hn,"getAngleLines");function Al({plotRect:e,viewMatrix:o,cameraState:t,fontFamily:r="Arial, Helvetica, sans-serif",fontSize:n=11,sizePx:i=null,marginPx:s=null,padPx:h=null,ink:c=bt}){let f=c.surfaceInk;if(!e||!o)return"";let d=Me(Math.round(Number(n)||11),6,48),l=Me(Math.round(Number.isFinite(s)?s:d*.9),8,18),m=Math.floor(Math.min(e.width,e.height)-l*2);if(!Number.isFinite(m)||m<50)return"";let w=Number.isFinite(i)?i:d*6.5,y=Me(Math.round(w),76,Math.min(160,m)),x=Me(Math.round(Number.isFinite(h)?h:d*.7),6,Math.max(6,Math.round(y*.18))),S=Math.max(2,Math.round(d/5)),A=Me(Math.round(d*.55),6,10),g=e.x+e.width-y-l,_=e.y+l,k=g+y/2,v=Hn(t),z=Math.max(10,Math.round(d*1.15)),F=v.length?v.length*z+4:0,L=Math.max(1,y-x*2-F),R=_+x+L/2,C=Math.max(10,Math.min(y-x*2,L)*.38),P=Ft(o,[1,0,0]),D=Ft(o,[0,1,0]),B=Ft(o,[0,0,1]),I=[{name:"X",v:P,color:"#ef4444"},{name:"Y",v:D,color:"#22c55e"},{name:"Z",v:B,color:"#3b82f6"}];I.sort((U,X)=>(X.v[2]||0)-(U.v[2]||0));let $=[];$.push(`<g font-family="${xe(r)}" font-size="${d}" fill="${xe(f)}">`),$.push(`<rect x="${g}" y="${_}" width="${y}" height="${y}" rx="${A}" fill="${c.surface}" fill-opacity="0.85" stroke="${c.frame}" stroke-width="1"/>`);for(let U of I){let X=U.v[0],ne=U.v[1],ye=U.v[2],V=Xn(X,ne),le=X/V*C,be=-ne/V*C,ze=Me(.35+(1-(ye+1)/2)*.65,.35,1),He=k+le,Ne=R+be,Ie=le/Math.max(1e-6,C),Ke=be/Math.max(1e-6,C),qe=Me(Math.round(d*.55),5,10),_e=He+Ie*qe,M=Ne+Ke*qe,j=Ie>.25?"start":Ie<-.25?"end":"middle";$.push(`<line x1="${k}" y1="${R}" x2="${He}" y2="${Ne}" stroke="${U.color}" stroke-width="${S}" stroke-linecap="round" opacity="${ze.toFixed(3)}"/>`),$.push(`<text x="${_e}" y="${M}" text-anchor="${j}" dominant-baseline="middle" fill="${U.color}" font-weight="600" opacity="${ze.toFixed(3)}" stroke="none">${U.name}</text>`)}if(v.length){let U=_+y-x;for(let X=0;X<v.length;X++){let ne=U-(v.length-1-X)*z;$.push(`<text x="${g+y/2}" y="${ne}" text-anchor="middle" fill="${c.surfaceInk}" stroke="none">${xe(v[X])}</text>`)}}return $.push("</g>"),$.join("")}a(Al,"renderSvgOrientationIndicator");function Ml({ctx:e,plotRect:o,viewMatrix:t,cameraState:r,fontFamily:n="Arial, Helvetica, sans-serif",fontSize:i=11,sizePx:s=null,marginPx:h=null,padPx:c=null,ink:f=bt}){if(!e||!o||!t)return;let d=Me(Math.round(Number(i)||11),6,48),l=Me(Math.round(Number.isFinite(h)?h:d*.9),8,18),m=Math.floor(Math.min(o.width,o.height)-l*2);if(!Number.isFinite(m)||m<50)return;let w=Number.isFinite(s)?s:d*6.5,y=Me(Math.round(w),76,Math.min(160,m)),x=Me(Math.round(Number.isFinite(c)?c:d*.7),6,Math.max(6,Math.round(y*.18))),S=Math.max(2,Math.round(d/5)),A=Me(Math.round(d*.55),6,10),g=o.x+o.width-y-l,_=o.y+l,k=g+y/2,v=Hn(r),z=Math.max(10,Math.round(d*1.15)),F=v.length?v.length*z+4:0,L=Math.max(1,y-x*2-F),R=_+x+L/2,C=Math.max(10,Math.min(y-x*2,L)*.38),P=Ft(t,[1,0,0]),D=Ft(t,[0,1,0]),B=Ft(t,[0,0,1]),I=[{name:"X",v:P,color:"#ef4444"},{name:"Y",v:D,color:"#22c55e"},{name:"Z",v:B,color:"#3b82f6"}];I.sort(($,U)=>(U.v[2]||0)-($.v[2]||0)),e.save(),e.globalAlpha=.85,e.fillStyle=f.surface,e.strokeStyle=f.frame,e.lineWidth=1,Ti(e,g,_,y,y,A),e.fill(),e.globalAlpha=1,e.stroke();for(let $ of I){let U=$.v[0],X=$.v[1],ne=$.v[2],ye=Xn(U,X),V=U/ye*C,le=-X/ye*C,be=Me(.35+(1-(ne+1)/2)*.65,.35,1),ze=k+V,He=R+le;e.globalAlpha=be,e.strokeStyle=$.color,e.lineWidth=S,e.beginPath(),e.moveTo(k,R),e.lineTo(ze,He),e.stroke();let Ne=V/Math.max(1e-6,C),Ie=le/Math.max(1e-6,C),Ke=Me(Math.round(d*.55),5,10),qe=ze+Ne*Ke,_e=He+Ie*Ke;e.fillStyle=$.color,e.font=`600 ${d}px ${n}`,e.textAlign=Ne>.25?"left":Ne<-.25?"right":"center",e.textBaseline="middle",e.fillText($.name,qe,_e)}if(e.globalAlpha=1,v.length){e.fillStyle=f.surfaceInk,e.font=`${d}px ${n}`,e.textAlign="center",e.textBaseline="alphabetic";let $=_+y-x;for(let U=0;U<v.length;U++){let X=$-(v.length-1-U)*z;e.fillText(v[U],g+y/2,X)}}e.restore()}a(Ml,"drawCanvasOrientationIndicator");function Wn(e){return{points:!!e?.points,labels:!!e?.labels}}a(Wn,"normalizeFlags");function Yn(e,o){if(!Array.isArray(e)||!Number.isFinite(o))return"";let t=e[o];return t==null?"":String(t)}a(Yn,"getLabelAtIndex");function Ol({positions:e,colors:o,labelTexts:t=null,flags:r=null,renderState:n,plotRect:i,pointRadiusPx:s,crop:h=null,fontFamily:c="Arial, Helvetica, sans-serif",labelFontSizePx:f=12,labelColor:d="#111",haloColor:l="#ffffff"}){let m=Wn(r);if(!m.points&&!m.labels||!e||!o||!n?.mvpMatrix)return"";let w=Math.max(6,Math.round(Number(f)||12)),y=Math.max(1.5,Math.round(w*.28)),x=Math.max(.5,Math.min(2.5,Number(s||1)*.18)),S=xe(d),A=[];return A.push(`<g font-family="${xe(c)}" fill="${xe(d)}">`),Po({positions:e,dimension:3,colors:o,colorAlpha:"opacity",transparency:null,renderState:n,plotRect:i,radiusPx:Math.max(.5,Number(s)||.5),lodMembership:null,crop:h,sortByDepth:!1,onPoint:a((g,_,k,v,z,F,L,R)=>{if(!(F<Oo)){if(m.points){let C=`rgb(${k},${v},${z})`;F>=.999?A.push(`<circle cx="${g.toFixed(2)}" cy="${_.toFixed(2)}" r="${L.toFixed(2)}" fill="${C}" stroke="${S}" stroke-width="${x.toFixed(2)}"/>`):A.push(`<circle cx="${g.toFixed(2)}" cy="${_.toFixed(2)}" r="${L.toFixed(2)}" fill="${C}" fill-opacity="${F.toFixed(3)}" stroke="${S}" stroke-width="${x.toFixed(2)}" stroke-opacity="${F.toFixed(3)}"/>`)}if(m.labels){let C=Yn(t,R);if(!C)return;let P=xe(C),D=g.toFixed(2),B=_.toFixed(2);A.push(`<text x="${D}" y="${B}" font-size="${w}" text-anchor="middle" dy="0.35em" stroke="${xe(l)}" stroke-width="${y}" stroke-linejoin="round" fill="none">${P}</text>`),A.push(`<text x="${D}" y="${B}" font-size="${w}" text-anchor="middle" dy="0.35em" fill="${xe(d)}">${P}</text>`)}}},"onPoint")}),A.push("</g>"),A.join("")}a(Ol,"renderSvgCentroidOverlay");function Fl({ctx:e,positions:o,colors:t,labelTexts:r=null,flags:n=null,renderState:i,plotRect:s,pointRadiusPx:h,crop:c=null,fontFamily:f="Arial, Helvetica, sans-serif",labelFontSizePx:d=12,labelColor:l="#111",haloColor:m="rgba(255,255,255,0.95)"}){let w=Wn(n);if(!w.points&&!w.labels||!e||!o||!t||!i?.mvpMatrix)return;let y=Math.max(6,Math.round(Number(d)||12)),x=Math.max(1,Math.round(y*.28)),S=$t(l),A=S===null?[17,17,17]:S.map(g=>Math.round(g*255));e.save(),e.font=`${y}px ${f}`,e.textAlign="center",e.textBaseline="alphabetic",Po({positions:o,dimension:3,colors:t,colorAlpha:"opacity",transparency:null,renderState:i,plotRect:s,radiusPx:Math.max(.5,Number(h)||.5),lodMembership:null,crop:c,sortByDepth:!1,onPoint:a((g,_,k,v,z,F,L,R)=>{if(!(F<Oo)&&(w.points&&(e.fillStyle=`rgba(${k},${v},${z},${F})`,e.beginPath(),e.arc(g,_,L,0,Math.PI*2),e.fill(),e.strokeStyle=`rgba(${A[0]},${A[1]},${A[2]},${F})`,e.lineWidth=Math.max(.5,Math.min(2.5,L*.18)),e.stroke()),w.labels)){let C=Yn(r,R);if(!C)return;e.lineWidth=x,e.strokeStyle=m,e.fillStyle=l,e.strokeText(C,g,_+y*.35),e.fillText(C,g,_+y*.35)}},"onPoint")}),e.restore()}a(Fl,"drawCanvasCentroidOverlay");function Ze(e,o){let[t,r,n]=o;return{x:e[0]*t+e[4]*r+e[8]*n+e[12],y:e[1]*t+e[5]*r+e[9]*n+e[13],z:e[2]*t+e[6]*r+e[10]*n+e[14],w:e[3]*t+e[7]*r+e[11]*n+e[15]}}a(Ze,"toClipSpace");function _o(e,o){let t=0,r=1,n=[[e.z+e.w,o.z+o.w],[e.w-e.z,o.w-o.z]];for(let[i,s]of n){if(i<0&&s<0)return null;if(i===s)continue;let h=i/(i-s);i<0?h>t&&(t=h):s<0&&h<r&&(r=h)}return r>t?[t,r]:null}a(_o,"clipSegmentDepthRange");function xt(e,o,t){return[e[0]+(o[0]-e[0])*t,e[1]+(o[1]-e[1])*t,e[2]+(o[2]-e[2])*t]}a(xt,"lerpPoint");function Lt({renderState:e,plotRect:o,crop:t=null}){let r=Math.max(1,e.viewportWidth||1),n=Math.max(1,e.viewportHeight||1),i=so(t),s=Yr(i,r,n),h=!!(s&&(s.width<r-.5||s.height<n-.5||s.x>.5||s.y>.5)),c=h&&s?s.x:0,f=h&&s?s.y:0,d=h&&s?s.width:r,l=h&&s?s.height:n,m=Math.min(o.width/d,o.height/l),w=o.x+(o.width-d*m)/2,y=o.y+(o.height-l*m)/2,x=a((g,_)=>({x:w+(g-c)*m,y:y+(_-f)*m}),"viewportToPlot"),S=a(g=>g.w>1e-9?{x:(g.x/g.w*.5+.5)*r,y:(-g.y/g.w*.5+.5)*n}:null,"clipToViewport");return{viewportW:r,viewportH:n,srcX0:c,srcY0:f,srcW:d,srcH:l,scale:m,viewportToPlot:x,clipToViewport:S,toPlot:a(g=>{let _=S(g);return _===null?null:x(_.x,_.y)},"toPlot")}}a(Lt,"createPlotProjection");var ur=64,dr=40,Kn=24,Vn=12,Zn=.5/255,qn=Math.log(Xe.ratio);function Ao(e,o,t){return[e[0]+(o[0]-e[0])*t,e[1]+(o[1]-e[1])*t,e[2]+(o[2]-e[2])*t]}a(Ao,"mixRgb");function Si(e){let o=e[0],t=e[1],r=e[2],n=e[3],i=e[4],s=e[5],h=e[6],c=e[7],f=e[8],d=e[9],l=e[10],m=e[11],w=e[12],y=e[13],x=e[14],S=e[15],A=o*s-t*i,g=o*h-r*i,_=o*c-n*i,k=t*h-r*s,v=t*c-n*s,z=r*c-n*h,F=f*y-d*w,L=f*x-l*w,R=f*S-m*w,C=d*x-l*y,P=d*S-m*y,D=l*S-m*x,B=A*D-g*P+_*C+k*R-v*L+z*F;if(!Number.isFinite(B)||B===0)return null;let I=1/B;return[(s*D-h*P+c*C)*I,(r*P-t*D-n*C)*I,(y*z-x*v+S*k)*I,(l*v-d*z-m*k)*I,(h*R-i*D-c*L)*I,(o*D-r*R+n*L)*I,(x*_-w*z-S*g)*I,(f*z-l*_+m*g)*I,(i*P-s*R+c*F)*I,(t*R-o*P-n*F)*I,(w*v-y*_+S*A)*I,(d*_-f*v-m*A)*I,(s*L-i*C-h*F)*I,(o*C-t*L+r*F)*I,(y*g-w*k-x*A)*I,(f*k-d*g+l*A)*I]}a(Si,"invertMatrix4");function hr(e){if(e===0)return 1/0;let o=0,t=Math.abs(e);for(;t%Xe.ratio===0&&o<64;)t/=Xe.ratio,o+=1;return o}a(hr,"divisibilityDepth");function Qn({appearance:e,renderState:o,plotRect:t,crop:r=null,surface:n}){let i=o?.backdrop;if(!(o?.mvpMatrix instanceof Float32Array)||o.mvpMatrix.length!==16||!(o.viewMatrix instanceof Float32Array)||o.viewMatrix.length!==16||!Array.isArray(o.cameraPosition)||i===null||typeof i!="object")throw new TypeError("Studio backdrop export requires exact matrices, the camera position, and the pane backdrop.");if(!Number.isFinite(t?.width)||t.width<=0||!Number.isFinite(t?.height)||t.height<=0)throw new TypeError("Studio backdrop export requires a positive plot rectangle.");if(!Array.isArray(n?.rgb)||n.rgb.length!==3||typeof n.viewerPaper!="boolean")throw new TypeError("Studio backdrop export requires the resolved figure surface.");let s=e.palette,h=Ut(s.ink),c=Ut(s.glow),f=n.rgb,d=o.mvpMatrix,l=o.cameraPosition,m=i.pixelRatio,w=Lt({renderState:o,plotRect:t,crop:r}),{viewportW:y,viewportH:x,srcX0:S,srcY0:A,srcW:g,srcH:_,scale:k}=w,v=Si(d);if(v===null)return null;let z=i.glowCenterX,F=Math.max(1-z,.001),L=n.viewerPaper,R=tn(i.planarity,{}),C=R.floor,P=rn(d,l,i,{}),D=P.gate*s.poolAlpha*C,B=P.axisAX*P.axisBY-P.axisBX*P.axisAY,I=a((M,j)=>{let Y=M/y*2-1,ee=1-j/x*2,te=f;if(L){let W=Math.hypot((Y-z)/F,ee);te=Ao(te,c,lo(W))}if(D>0){let W=Y-P.centerX,Z=ee-P.centerY,ue=(P.axisBY*W-P.axisBX*Z)/B,ge=(-P.axisAY*W+P.axisAX*Z)/B;te=Ao(te,h,lo(Math.hypot(ue,ge))*D)}return te},"baseAt"),$=a(M=>Math.max(Math.abs(h[0]-M[0]),Math.abs(h[1]-M[1]),Math.abs(h[2]-M[2])),"contrastAt"),U=a((M,j)=>M[0]*j[0]+M[1]*j[1]+M[2]*j[2],"dot3"),X=[];if(C>0&&X.push({normal:[0,1,0],offset:i.floorY,u:[1,0,0],v:[0,0,1],weight:C,lineMix:1,dotMix:0,surface:Do.floor,floor:!0}),R.backdrop>0){let M=on(o.viewMatrix,i,{});X.push({normal:[M.normalX,M.normalY,M.normalZ],offset:M.offset,u:[M.uX,M.uY,M.uZ],v:[M.vX,M.vY,M.vZ],weight:R.backdrop,lineMix:0,dotMix:1,surface:Do.backdrop,floor:!1})}let ne=a((M,j,Y)=>[M.normal[0]*M.offset+M.u[0]*j+M.v[0]*Y,M.normal[1]*M.offset+M.u[1]*j+M.v[1]*Y,M.normal[2]*M.offset+M.u[2]*j+M.v[2]*Y],"pointOn"),ye=a((M,j)=>{let Y=j[0]-l[0],ee=j[1]-l[1],te=j[2]-l[2],W=Math.hypot(Y,ee,te);if(!(W>0))return 0;if(M.floor)return M.weight*en(Math.hypot(j[0]-i.stageX,j[2]-i.stageZ))*fo(-ee/W)*uo(l[1]-M.offset);let Z=M.offset-U(M.normal,l),ue=U(M.normal,[Y,ee,te]);return Z*ue<0?0:M.weight*fo(Math.abs(ue)/W)*uo(Math.abs(Z))},"fadeAt"),V=a((M,j)=>{let Y=1e-4*Math.max(1,Math.hypot(j[0]-l[0],j[1]-l[1],j[2]-l[2])),ee=w.clipToViewport(Ze(d,j)),te=j.map((he,me)=>he+M.u[me]*Y),W=j.map((he,me)=>he+M.v[me]*Y),Z=w.clipToViewport(Ze(d,te)),ue=w.clipToViewport(Ze(d,W));if(ee===null||Z===null||ue===null)return null;let ge=(Z.x-ee.x)/Y,Re=(Z.y-ee.y)/Y,ae=(ue.x-ee.x)/Y,fe=(ue.y-ee.y)/Y,Ce=Math.abs(ge*fe-ae*Re);if(!(Ce>0))return null;let $e=Math.max(Math.hypot(ae,fe)/Ce,Math.hypot(ge,Re)/Ce);return{screen:ee,footprint:$e,level:Qr(M.surface,$e,m)}},"footprintAt"),le=[],be=[];for(let M of X){let j=[];for(let ae=0;ae<=dr;ae++)for(let fe=0;fe<=ur;fe++){let Ce=S+g*fe/ur,$e=A+_*ae/dr,he=Ce/y*2-1,me=1-$e/x*2,Ae=[v[0]*he+v[4]*me+v[8]+v[12],v[1]*he+v[5]*me+v[9]+v[13],v[2]*he+v[6]*me+v[10]+v[14],v[3]*he+v[7]*me+v[11]+v[15]];if(!(Math.abs(Ae[3])>0))continue;let Ue=[Ae[0]/Ae[3]-l[0],Ae[1]/Ae[3]-l[1],Ae[2]/Ae[3]-l[2]],Oe=U(M.normal,Ue);if(Math.abs(Oe)<1e-12)continue;let De=(M.offset-U(M.normal,l))/Oe;if(!(De>0))continue;let Te=[l[0]+Ue[0]*De,l[1]+Ue[1]*De,l[2]+Ue[2]*De];if(ye(M,Te)<=0)continue;let Je=V(M,Te);Je!==null&&j.push({u:U(Te,M.u),v:U(Te,M.v),footprint:Je.footprint,visibleFrom:Math.ceil(Math.log(Xe.fadeInFraction*M.surface.minCellCssPx*m*Je.footprint/Xe.base)/qn-1e-9)})}if(j.length===0)continue;let Y=1/0,ee=1/0,te=-1/0,W=1/0,Z=-1/0;for(let ae of j)Y=Math.min(Y,ae.visibleFrom),ee=Math.min(ee,ae.u),te=Math.max(te,ae.u),W=Math.min(W,ae.v),Z=Math.max(Z,ae.v);let ue=M.floor?2*Be.outerRadius:Math.max(te-ee,Z-W),ge=Math.max(Y,Math.ceil(Math.log(Math.max(ue,Xe.base)/Xe.base)/qn)+1),Re=Math.max(g/ur,_/dr);for(let ae=Y;ae<=ge;ae++){let fe=Uo(ae),Ce=1/0,$e=-1/0,he=1/0,me=-1/0,Ae=0;for(let we of j)we.visibleFrom>ae||(Ce=Math.min(Ce,we.u),$e=Math.max($e,we.u),he=Math.min(he,we.v),me=Math.max(me,we.v),Ae=Math.max(Ae,1.5*Re*we.footprint));if(!($e>=Ce))continue;Ce-=Ae,$e+=Ae,he-=Ae,me+=Ae,M.floor&&(Ce=Math.max(Ce,i.stageX-Be.outerRadius),$e=Math.min($e,i.stageX+Be.outerRadius),he=Math.max(he,i.stageZ-Be.outerRadius),me=Math.min(me,i.stageZ+Be.outerRadius));let Ue=Math.ceil(Ce/fe),Oe=Math.floor($e/fe),De=Math.ceil(he/fe),Te=Math.floor(me/fe);if(Oe<Ue||Te<De)continue;let Je=ae===ge,At=a(we=>Je||we%Xe.ratio!==0,"ownsIndex");if(M.lineMix>0)for(let[we,oe,se,q,J]of[[!0,Ue,Oe,he,me],[!1,De,Te,Ce,$e]])for(let Q=oe;Q<=se;Q++){if(!At(Q))continue;let ve=Q*fe,Se=ae+hr(Q);ze(M,we,ve,Se,q,J)}if(M.dotMix>0){let we=[],oe=0;for(let q of j){if(q.visibleFrom>ae)continue;let J=1.5*Re*q.footprint,Q=Math.max(Ue,Math.ceil((q.u-J)/fe)),ve=Math.min(Oe,Math.floor((q.u+J)/fe)),Se=Math.max(De,Math.ceil((q.v-J)/fe)),rt=Math.min(Te,Math.floor((q.v+J)/fe));ve<Q||rt<Se||(we.push(Q,ve,Se,rt),oe+=(ve-Q+1)*(rt-Se+1))}let se=a((q,J)=>{let Q=hr(q);for(let ve of J)!Je&&Q>0&&ve%Xe.ratio===0||He(M,q*fe,ve*fe,ae+Math.min(Q,hr(ve)))},"emitRow");if((Oe-Ue+1)*(Te-De+1)<=oe){let q=[];for(let J=De;J<=Te;J++)q.push(J);for(let J=Ue;J<=Oe;J++)se(J,q)}else{let q=new Map;for(let Q=0;Q<we.length;Q+=4)for(let ve=we[Q];ve<=we[Q+1];ve++){let Se=q.get(ve);Se===void 0&&(Se=new Set,q.set(ve,Se));for(let rt=we[Q+2];rt<=we[Q+3];rt++)Se.add(rt)}let J=a((Q,ve)=>Q-ve,"ascending");for(let Q of[...q.keys()].sort(J))se(Q,[...q.get(Q)].sort(J))}}}}function ze(M,j,Y,ee,te,W){let Z=te,ue=W;if(M.floor){let oe=j?i.stageX:i.stageZ,se=j?i.stageZ:i.stageX,q=Be.outerRadius**2-(Y-oe)**2;if(!(q>0))return;let J=Math.sqrt(q);Z=Math.max(Z,se-J),ue=Math.min(ue,se+J)}if(!(ue>Z))return;let ge=a(oe=>j?ne(M,Y,oe):ne(M,oe,Y),"pointAt"),Re=ge(Z),ae=ge(ue),fe=_o(Ze(d,Re),Ze(d,ae));if(fe===null)return;let Ce=xt(Re,ae,fe[0]),$e=xt(Re,ae,fe[1]),he=[],me=0,Ae=0,Ue=!1;for(let oe=0;oe<=Kn;oe++){let se=xt(Ce,$e,oe/Kn),q=V(M,se);if(q===null)return;let J=jo({coarsestLevel:ee,level:q.level,footprint:q.footprint,pixelRatio:m,surface:M.surface,minorAlpha:s.lineMinorAlpha,majorAlpha:s.lineMajorAlpha}),Q=ye(M,se)*M.lineMix*J.strength,ve=I(q.screen.x,q.screen.y);Q*$(ve)>=Zn&&(Ue=!0),Q>me&&(me=Q,Ae=J.majorness),he.push({plot:w.viewportToPlot(q.screen.x,q.screen.y),color:ct(Ao(ve,h,Q))})}if(!Ue)return;let Oe=he[0].plot,De=he[he.length-1].plot,Te=De.x-Oe.x,Je=De.y-Oe.y,At=Te*Te+Je*Je;if(!(At>0))return;let we=pt.lineWidthCssPx+(pt.majorLineWidthCssPx-pt.lineWidthCssPx)*Ae;le.push({x1:Oe.x,y1:Oe.y,x2:De.x,y2:De.y,widthPx:we*m*k,stops:he.map(oe=>({offset:Math.min(1,Math.max(0,((oe.plot.x-Oe.x)*Te+(oe.plot.y-Oe.y)*Je)/At)),color:oe.color}))})}a(ze,"emitRule");function He(M,j,Y,ee){let te=ne(M,j,Y),W=V(M,te);if(W===null)return;let Z=pt.majorDotRadiusCssPx*m;if(W.screen.x<S-Z||W.screen.x>S+g+Z||W.screen.y<A-Z||W.screen.y>A+_+Z)return;let ue=jo({coarsestLevel:ee,level:W.level,footprint:W.footprint,pixelRatio:m,surface:M.surface,minorAlpha:s.dotMinorAlpha,majorAlpha:s.dotMajorAlpha}),ge=ye(M,te)*M.dotMix*ue.strength,Re=I(W.screen.x,W.screen.y);if(ge*$(Re)<Zn)return;let ae=pt.dotRadiusCssPx+(pt.majorDotRadiusCssPx-pt.dotRadiusCssPx)*ue.majorness,fe=w.viewportToPlot(W.screen.x,W.screen.y);be.push({cx:fe.x,cy:fe.y,r:ae*m*k,color:ct(Ao(Re,h,ge))})}a(He,"emitDot");let Ne=.5*y*k,Ie=-.5*x*k,Ke=a((M,j,Y,ee,te,W)=>{let Z=w.viewportToPlot((M*.5+.5)*y,(.5-j*.5)*x);return[Y*Ne,ee*Ie,te*Ne,W*Ie,Z.x,Z.y]},"ellipseMatrix"),qe=a((M,j)=>{let Y=[];for(let ee=0;ee<=Vn;ee++){let te=ee/Vn;Y.push({offset:te,color:M,opacity:lo(te)*j})}return Y},"falloffStops"),_e=[];return L&&_e.push({matrix:Ke(z,0,F,0,0,1),stops:qe(ct(c),1)}),D>0&&_e.push({matrix:Ke(P.centerX,P.centerY,P.axisAX,P.axisAY,P.axisBX,P.axisBY),stops:qe(ct(h),D)}),_e.length===0&&le.length===0&&be.length===0?null:{kind:"studio",rect:{x:t.x,y:t.y,width:t.width,height:t.height},gradients:_e,segments:le,dots:be}}a(Qn,"buildStudioBackdropModel");function Jn(e){return e.map(o=>`<stop offset="${o.offset.toFixed(4)}" stop-color="${o.color}"`+(o.opacity===void 0?"":` stop-opacity="${o.opacity.toFixed(5)}"`)+"/>").join("")}a(Jn,"formatStops");function ea(e,o){if(typeof o!="string"||!/^[A-Za-z][\w-]*$/.test(o))throw new TypeError("Studio backdrop SVG requires an exact element-id prefix.");let t=[],r=[],{rect:n}=e;if(e.gradients.forEach((i,s)=>{let h=`${o}-tone-${s}`;t.push(`<radialGradient id="${h}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${i.matrix.map(c=>c.toFixed(4)).join(" ")})">${Jn(i.stops)}</radialGradient>`),r.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="url(#${h})"/>`)}),e.segments.length>0&&(r.push('<g fill="none" stroke-linecap="butt">'),e.segments.forEach((i,s)=>{let h=`${o}-rule-${s}`;t.push(`<linearGradient id="${h}" gradientUnits="userSpaceOnUse" x1="${i.x1.toFixed(2)}" y1="${i.y1.toFixed(2)}" x2="${i.x2.toFixed(2)}" y2="${i.y2.toFixed(2)}">${Jn(i.stops)}</linearGradient>`),r.push(`<line x1="${i.x1.toFixed(2)}" y1="${i.y1.toFixed(2)}" x2="${i.x2.toFixed(2)}" y2="${i.y2.toFixed(2)}" stroke="url(#${h})" stroke-width="${i.widthPx.toFixed(3)}"/>`)}),r.push("</g>")),e.dots.length>0){r.push('<g stroke="none">');for(let i of e.dots)r.push(`<circle cx="${i.cx.toFixed(2)}" cy="${i.cy.toFixed(2)}" r="${i.r.toFixed(3)}" fill="${i.color}"/>`);r.push("</g>")}return'<g class="cellucid-studio-backdrop">'+(t.length>0?`<defs>${t.join("")}</defs>`:"")+r.join("")+"</g>"}a(ea,"renderSvgStudioBackdrop");function ki(e,o){if(o===void 0)return e;let t=Number.parseInt(e.slice(1),16);return`rgba(${t>>16&255}, ${t>>8&255}, ${t&255}, ${o})`}a(ki,"canvasColor");function ta({ctx:e,model:o}){e.save();let{rect:t}=o;for(let r of o.gradients){e.save(),e.beginPath(),e.rect(t.x,t.y,t.width,t.height),e.transform(...r.matrix);let n=e.createRadialGradient(0,0,0,0,0,1);for(let i of r.stops)n.addColorStop(i.offset,ki(i.color,i.opacity));e.fillStyle=n,e.fill(),e.restore()}e.lineCap="butt";for(let r of o.segments){let n=e.createLinearGradient(r.x1,r.y1,r.x2,r.y2);for(let i of r.stops)n.addColorStop(i.offset,i.color);e.beginPath(),e.moveTo(r.x1,r.y1),e.lineTo(r.x2,r.y2),e.strokeStyle=n,e.lineWidth=r.widthPx,e.stroke()}for(let r of o.dots)e.beginPath(),e.arc(r.cx,r.cy,r.r,0,Math.PI*2),e.fillStyle=r.color,e.fill();e.restore()}a(ta,"drawCanvasStudioBackdrop");var Ri=.35,Ci=.16,$i=.6,Oi=.58,Fi=.5,Li=.18,Pi=.65,zi=.32,Ni=.03,Ii=.55,Di=.55,pr=Object.freeze([.2126,.7152,.0722]),Bi=5,Ui=.5,ji=.5*1.2,Gi=1.4,Xi=1.55,Hi=-.2,Wi=.05,Yi=.01,Ki=Object.freeze(["x","y","z"]),Vi=Object.freeze([Object.freeze({key:"bottom",fixedAxis:1,fixedSign:-1,axisA:0,axisB:2}),Object.freeze({key:"top",fixedAxis:1,fixedSign:1,axisA:0,axisB:2}),Object.freeze({key:"back",fixedAxis:2,fixedSign:-1,axisA:0,axisB:1}),Object.freeze({key:"front",fixedAxis:2,fixedSign:1,axisA:0,axisB:1}),Object.freeze({key:"left",fixedAxis:0,fixedSign:-1,axisA:1,axisB:2}),Object.freeze({key:"right",fixedAxis:0,fixedSign:1,axisA:1,axisB:2})]),Zi=0,qi=1,Ji=2,Qi=3;function es(e,o,t){let r=Math.max(0,Math.min(1,(t-e)/(o-e)));return r*r*(3-2*r)}a(es,"smoothstep");function mr(e,o,t){return[e[0]+(o[0]-e[0])*t,e[1]+(o[1]-e[1])*t,e[2]+(o[2]-e[2])*t]}a(mr,"mixRgb");function Pt(e,o){if(!Array.isArray(e)&&!(e instanceof Float32Array)||e.length!==3||Array.from(e).some(t=>!Number.isFinite(t)||t<0||t>1))throw new TypeError(`${o} must contain exactly three 0..1 numbers.`);return[e[0],e[1],e[2]]}a(Pt,"assertRgb01");function ts(e,o){let t=Math.round(e/o);if(t<1||Math.abs(t*o-e)>1e-6)throw new RangeError("Reference grid spacing must divide the grid half-extent exactly.");let r=[];for(let n=-t;n<=t;n++){let i=n===0,s=Math.abs(n)===t,h=n%Bi===0,c=Zi;i?c=Qi:s?c=Ji:h&&(c=qi),r.push({coordinate:n*o,minor:!0,major:h,frame:s,origin:i,rank:c})}return r}a(ts,"enumerateRuleCoordinates");function os({rule:e,strengths:o,lineWidth:t,lineColor:r,axisColor:n,surfaceRgb:i,effectiveOpacity:s}){let h=[{half:Ui,strength:o.minor,axis:!1}];e.major&&h.push({half:ji,strength:o.major,axis:!1}),e.frame&&h.push({half:Gi,strength:o.frame,axis:!1}),e.origin&&h.push({half:Xi,strength:o.axis,axis:!0});let c=[...new Set(h.map(d=>d.half))].sort((d,l)=>l-d),f=[];for(let d of c){let l=0,m=0;for(let x of h)x.half<d||(x.axis?m=x.strength:l+=x.strength);if(l=Math.min(1,l),l<=0&&m<=0)continue;let w=mr(i,r,l);m>0&&(w=mr(w,n,m));let y=mr(i,w,s);f.push({halfWidthWorld:d*t,color:ct(y)})}return f}a(os,"buildRuleBands");function Yl({appearance:e,background:o,backgroundColor:t}){if(e==null)return null;let r=[e.surfaceColor[0],e.surfaceColor[1],e.surfaceColor[2]];if(o==="transparent")return Object.freeze({rgb:r,viewerPaper:!1});let n=$t(t);if(n===null)throw new TypeError("Reference grid export requires an exact #RRGGBB figure background.");return Object.freeze({rgb:n,viewerPaper:ct(n)===ct(r)})}a(Yl,"resolveReferenceGridSurface");function Kl({appearance:e,renderState:o,plotRect:t,crop:r=null,surface:n}){if(e==null||e.kind==="look")return null;if(e.kind==="studio")return Qn({appearance:e,renderState:o,plotRect:t,crop:r,surface:n});if(!(o?.mvpMatrix instanceof Float32Array)||o.mvpMatrix.length!==16||!(o.viewMatrix instanceof Float32Array)||o.viewMatrix.length!==16)throw new TypeError("Reference grid export requires exact 16-value MVP and view matrices.");if(!Number.isFinite(t?.width)||t.width<=0||!Number.isFinite(t?.height)||t.height<=0)throw new TypeError("Reference grid export requires a positive plot rectangle.");let i=Pt(n?.rgb,"Reference grid surface colour"),s=Pt(e.lineColor,"Reference grid line colour"),h={x:Pt(e.axisColors.x,"Reference grid X-axis colour"),y:Pt(e.axisColors.y,"Reference grid Y-axis colour"),z:Pt(e.axisColors.z,"Reference grid Z-axis colour")},c=Pt(e.surfaceColor,"Reference grid viewer surface colour"),d=c[0]*pr[0]+c[1]*pr[1]+c[2]*pr[2]>=Di?1:0,l=e.size,m=e.spacing,w=e.lineWidth,y=e.opacity,x=o.mvpMatrix,S=o.viewMatrix,{toPlot:A}=Lt({renderState:o,plotRect:t,crop:r}),g=[-S[2],-S[6],-S[10]],_=ts(l,m),k=[],v=Math.max(t.width,t.height),z=t.x-v,F=t.x+t.width+v,L=t.y-v,R=t.y+t.height+v;for(let C of Vi){let P=[0,0,0];P[C.fixedAxis]=C.fixedSign;let D=g[0]*P[0]+g[1]*P[1]+g[2]*P[2],B=es(Hi,Wi,D);if(B<Yi)continue;let I=y*B,$={minor:(Ri+Ci*d)*I**$i,major:Oi*I**Fi,frame:Li*I**Pi,axis:(zi+Ni*d)*I**Ii},U=[];for(let[X,ne]of[[C.axisA,C.axisB],[C.axisB,C.axisA]])for(let ye of _)U.push({rule:ye,constantAxis:X,runningAxis:ne});U.sort((X,ne)=>X.rule.rank-ne.rule.rank);for(let{rule:X,constantAxis:ne,runningAxis:ye}of U){let V=[0,0,0],le=[0,0,0];V[C.fixedAxis]=C.fixedSign*l,le[C.fixedAxis]=C.fixedSign*l,V[ne]=X.coordinate,le[ne]=X.coordinate,V[ye]=-l,le[ye]=l;let be=Ze(x,V),ze=Ze(x,le),He=_o(be,ze);if(He===null)continue;let[Ne,Ie]=He,Ke=xt(V,le,Ne),qe=xt(V,le,Ie),_e=A(Ze(x,Ke)),M=A(Ze(x,qe));if(_e===null||M===null||_e.x<z&&M.x<z||_e.x>F&&M.x>F||_e.y<L&&M.y<L||_e.y>R&&M.y>R)continue;let j=xt(Ke,qe,.5),Y=h[Ki[ye]],ee=os({rule:X,strengths:$,lineWidth:w,lineColor:s,axisColor:Y,surfaceRgb:i,effectiveOpacity:I});for(let te of ee){let W=[...j],Z=[...j];W[ne]-=te.halfWidthWorld,Z[ne]+=te.halfWidthWorld;let ue=A(Ze(x,W)),ge=A(Ze(x,Z));if(ue===null||ge===null)continue;let Re=Math.hypot(ge.x-ue.x,ge.y-ue.y);!Number.isFinite(Re)||Re<=0||k.push({x1:_e.x,y1:_e.y,x2:M.x,y2:M.y,widthPx:Re,color:te.color})}}}return k.length===0?null:{kind:"grid",segments:k}}a(Kl,"buildReferenceGridModel");function Vl(e,o){if(e===null)return"";if(e.kind==="studio")return ea(e,o);let t=['<g class="cellucid-reference-grid" fill="none" stroke-linecap="butt">'];for(let r of e.segments)t.push(`<line x1="${r.x1.toFixed(2)}" y1="${r.y1.toFixed(2)}" x2="${r.x2.toFixed(2)}" y2="${r.y2.toFixed(2)}" stroke="${r.color}" stroke-width="${r.widthPx.toFixed(3)}"/>`);return t.push("</g>"),t.join("")}a(Vl,"renderSvgReferenceGrid");function Zl({ctx:e,model:o}){if(o!==null){if(o.kind==="studio"){ta({ctx:e,model:o});return}e.save(),e.lineCap="butt";for(let t of o.segments)e.beginPath(),e.moveTo(t.x1,t.y1),e.lineTo(t.x2,t.y2),e.strokeStyle=t.color,e.lineWidth=t.widthPx,e.stroke();e.restore()}}a(Zl,"drawCanvasReferenceGrid");var ra=Object.freeze(["BLEND","CULL_FACE","DEPTH_TEST","DITHER","POLYGON_OFFSET_FILL","RASTERIZER_DISCARD","SAMPLE_ALPHA_TO_COVERAGE","SAMPLE_COVERAGE","SCISSOR_TEST","STENCIL_TEST"]),na=Symbol("forget"),oa=new WeakMap;function rs(e){let o=new Map,t=new Set;for(let c of ra)Number.isInteger(e[c])&&t.add(e[c]);let r=new Map,n=a(()=>{o.clear(),r.clear()},"forget"),i=a((c,f)=>(r.has(c)||r.set(c,f()),r.get(c)),"read"),s=a((c,f)=>{let d=e[c];typeof d=="function"&&(e[c]=a(function(...m){let w=Reflect.apply(d,e,m);return f(...m),w},"shadowedSetter"))},"wrap");return s("enable",c=>{t.has(c)&&o.set(c,!0)}),s("disable",c=>{t.has(c)&&o.set(c,!1)}),s("activeTexture",c=>{r.set("activeTexture",c)}),s("viewport",(c,f,d,l)=>{r.set("viewport",Int32Array.of(c,f,d,l))}),s("scissor",(c,f,d,l)=>{r.set("scissorBox",Int32Array.of(c,f,d,l))}),s("colorMask",(c,f,d,l)=>{r.set("colorMask",[!!c,!!f,!!d,!!l])}),s("clearColor",(c,f,d,l)=>{r.set("clearColor",[Math.fround(c),Math.fround(f),Math.fround(d),Math.fround(l)])}),s("blendFunc",(c,f)=>{r.set("blendFunc",{srcRgb:c,dstRgb:f,srcAlpha:c,dstAlpha:f})}),s("blendFuncSeparate",(c,f,d,l)=>{r.set("blendFunc",{srcRgb:c,dstRgb:f,srcAlpha:d,dstAlpha:l})}),s("blendEquation",c=>{r.set("blendEquation",{rgb:c,alpha:c})}),s("blendEquationSeparate",(c,f)=>{r.set("blendEquation",{rgb:c,alpha:f})}),s("depthMask",c=>{r.set("depthMask",!!c)}),s("vertexAttrib4f",(c,f,d,l,m)=>{r.set(`generic${c}`,Float32Array.of(f,d,l,m))}),s("vertexAttribI4i",(c,f,d,l,m)=>{r.set(`generic${c}`,Int32Array.of(f,d,l,m))}),s("vertexAttribI4ui",(c,f,d,l,m)=>{r.set(`generic${c}`,Uint32Array.of(f,d,l,m))}),Object.freeze({[na]:n,isEnabled(c){if(!t.has(c))throw new RangeError(`The WebGL state shadow does not track capability 0x${Number(c).toString(16)}.`);return o.has(c)||o.set(c,e.isEnabled(c)===!0),o.get(c)},get activeTexture(){return i("activeTexture",()=>e.getParameter(e.ACTIVE_TEXTURE))},get viewport(){return Int32Array.from(i("viewport",()=>Int32Array.from(e.getParameter(e.VIEWPORT))))},get scissorBox(){return Int32Array.from(i("scissorBox",()=>Int32Array.from(e.getParameter(e.SCISSOR_BOX))))},get colorMask(){return[...i("colorMask",()=>Array.from(e.getParameter(e.COLOR_WRITEMASK),Boolean))]},get clearColor(){return[...i("clearColor",()=>Array.from(e.getParameter(e.COLOR_CLEAR_VALUE)))]},get blendFunc(){return{...i("blendFunc",()=>({srcRgb:e.getParameter(e.BLEND_SRC_RGB),dstRgb:e.getParameter(e.BLEND_DST_RGB),srcAlpha:e.getParameter(e.BLEND_SRC_ALPHA),dstAlpha:e.getParameter(e.BLEND_DST_ALPHA)}))}},get blendEquation(){return{...i("blendEquation",()=>({rgb:e.getParameter(e.BLEND_EQUATION_RGB),alpha:e.getParameter(e.BLEND_EQUATION_ALPHA)}))}},get depthMask(){return i("depthMask",()=>e.getParameter(e.DEPTH_WRITEMASK)===!0)},genericAttribute(c){let f=r.get(`generic${c}`)??Float32Array.of(0,0,0,1);return new f.constructor(f)}})}a(rs,"createShadow");function Ql(e){let o=br(e);o[na]();for(let t of ra)Number.isInteger(e[t])&&o.isEnabled(e[t]);for(let t of["activeTexture","viewport","scissorBox","colorMask","clearColor","blendFunc","blendEquation","depthMask"])o[t]}a(Ql,"primeGlState");function br(e){let o=oa.get(e);return o===void 0&&(o=rs(e),oa.set(e,o)),o}a(br,"glStateOf");var _t=`#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform vec4 u_ndcTransform;
out vec2 v_ndc;
void main() {
  v_ndc = a_corner * u_ndcTransform.xy + u_ndcTransform.zw;
  gl_Position = vec4(a_corner, 1.0, 1.0);
}
`,aa=`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
vec3 noiseGrad(vec3 c, vec2 per) {
  c.xy = mod(c.xy, per);
  return hash33(c) * 2.0 - 1.0;
}
// Gradient noise, about -1..1, periodic in x and y with period per.
float gnoise(vec3 p, vec2 per) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(noiseGrad(i, per), f);
  float n100 = dot(noiseGrad(i + vec3(1, 0, 0), per), f - vec3(1, 0, 0));
  float n010 = dot(noiseGrad(i + vec3(0, 1, 0), per), f - vec3(0, 1, 0));
  float n110 = dot(noiseGrad(i + vec3(1, 1, 0), per), f - vec3(1, 1, 0));
  float n001 = dot(noiseGrad(i + vec3(0, 0, 1), per), f - vec3(0, 0, 1));
  float n101 = dot(noiseGrad(i + vec3(1, 0, 1), per), f - vec3(1, 0, 1));
  float n011 = dot(noiseGrad(i + vec3(0, 1, 1), per), f - vec3(0, 1, 1));
  float n111 = dot(noiseGrad(i + vec3(1, 1, 1), per), f - vec3(1, 1, 1));
  return 1.7 * mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}
// Fractal sum; every octave doubles the frequency and the period, so a
// periodic input stays periodic.
float fbm(vec3 p, vec2 per, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise(p, per);
    norm += amp;
    p = vec3(p.xy * 2.0, p.z * 2.0 + 1.31);
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
float ridged(vec3 p, vec2 per, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  float prev = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gnoise(p, per));
    n *= n;
    sum += amp * n * prev;
    prev = clamp(n * 1.6, 0.0, 1.0);
    norm += amp;
    p = vec3(p.xy * 2.0, p.z * 2.0 + 0.77);
    per *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
`,ia=`
vec3 cubeFaceDir(int face, vec2 uv) {
  if (face == 0) return vec3(1.0, -uv.y, -uv.x);
  if (face == 1) return vec3(-1.0, -uv.y, uv.x);
  if (face == 2) return vec3(uv.x, 1.0, uv.y);
  if (face == 3) return vec3(uv.x, -1.0, -uv.y);
  if (face == 4) return vec3(uv.x, -uv.y, 1.0);
  return vec3(-uv.x, -uv.y, -1.0);
}
// Inverse of cubeFaceDir: the face and its uv (-1..1) of a direction.
int cubeFaceOf(vec3 d, out vec2 uv) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    uv = d.x > 0.0 ? vec2(-d.z, -d.y) / a.x : vec2(d.z, -d.y) / a.x;
    return d.x > 0.0 ? 0 : 1;
  }
  if (a.y >= a.z) {
    uv = d.y > 0.0 ? vec2(d.x, d.z) / a.y : vec2(d.x, -d.z) / a.y;
    return d.y > 0.0 ? 2 : 3;
  }
  uv = d.z > 0.0 ? vec2(d.x, -d.y) / a.z : vec2(-d.x, -d.y) / a.z;
  return d.z > 0.0 ? 4 : 5;
}
`,sa=`
// x: present (0/1), y: magnitude 0..1, z: colour temperature 0..1; dir out.
vec3 starInCell(int face, vec2 cell, float cells, float probability, float seed, out vec3 dir) {
  vec3 key = vec3(cell, float(face) * 131.0 + seed);
  float h = hash13(key);
  vec2 jitter = 0.25 + 0.5 * hash22(cell + vec2(float(face) * 17.0 + seed, seed * 3.1));
  vec2 st = (cell + jitter) / cells;
  vec2 uv = st * 2.0 - 1.0;
  dir = normalize(cubeFaceDir(face, uv));
  float present = step(h, probability);
  float magnitude = hash13(key + 19.7);
  return vec3(present, magnitude, hash13(key + 5.3));
}
vec3 starTint(float temperature) {
  return mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.80, 0.58), temperature);
}
`,xr=`#version 300 es
precision highp float;
uniform int u_face;      // cube face 0..5, or -1 for the periodic tile
uniform float u_size;    // texels per side
out vec4 fragColor;
${aa}
${ia}
${sa}
`,ns=`${xr}
const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const float BRIGHT_CELLS = 40.0;

// Halos of the bright stars around a direction: the 3x3 cells of its face.
float starHalos(vec3 d) {
  vec2 uv;
  int face = cubeFaceOf(d, uv);
  vec2 st = uv * 0.5 + 0.5;
  vec2 base = floor(st * BRIGHT_CELLS);
  float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
  float halo = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = base + vec2(x, y);
      if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= BRIGHT_CELLS || cell.y >= BRIGHT_CELLS) continue;
      vec3 sd;
      vec3 star = starInCell(face, cell, BRIGHT_CELLS, 0.05 + 0.16 * band, 3.0, sd);
      if (star.x < 0.5) continue;
      float m = pow(star.y, 5.0);
      float ang = length(sd - d);
      float sigma = 0.0035 + 0.006 * m;
      halo += m * (exp(-ang * ang / (sigma * sigma)) * 2.4
        + 0.10 / (1.0 + pow(ang / (0.010 + 0.02 * m), 2.0)));
    }
  }
  return halo;
}

vec4 nebulaField(vec3 p, vec2 per, float band) {
  vec3 w = vec3(
    fbm(p + vec3(3.1, 7.7, 1.3), per, 5),
    fbm(p + vec3(8.4, 2.2, 5.9), per, 5),
    fbm(p + vec3(1.9, 4.6, 9.3), per, 5)
  );
  vec3 pw = p + w * 1.15;
  float large = fbm(pw, per, 7);
  float cloudA = smoothstep(-0.10, 0.70, large + band * 0.38 - 0.08);
  cloudA *= cloudA;
  float second = fbm(vec3(pw.xy * 2.0, pw.z * 2.0) + vec3(11.1, 3.3, 7.7), per * 2.0, 6);
  float cloudB = smoothstep(-0.05, 0.6, second) * smoothstep(-0.45, 0.35, large);
  float filaments = ridged(vec3(pw.xy * 3.0, pw.z * 3.0) + vec3(5.0, 1.0, 2.0), per * 3.0, 6);
  filaments = pow(filaments, 3.0) * smoothstep(-0.35, 0.45, large);
  float dustNoise = fbm(vec3(p.xy * 2.0, p.z * 2.0) + w * 1.6 + vec3(4.2, 0.4, 2.9), per * 2.0, 7);
  float dust = smoothstep(0.02, 0.5, dustNoise) * (0.4 + 0.6 * band);
  return vec4(cloudA, clamp(cloudB * 0.75 + filaments * 1.4, 0.0, 2.0), dust, 0.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    // Periodic tile for the near layer of planar panes: wisps and dust.
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.37);
    vec4 field = nebulaField(p, per, 0.3);
    fragColor = vec4(clamp(field.r, 0.0, 1.0), clamp(field.g * 0.5, 0.0, 1.0), field.b, 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
  vec4 field = nebulaField(d * 2.1, vec2(1e4), band);
  // RGBA8: filaments (0..2) stored halved, halo glow (HDR) as g / (1 + g).
  float halo = starHalos(d);
  fragColor = vec4(field.r, clamp(field.g * 0.5, 0.0, 1.0), field.b, halo / (1.0 + halo));
}
`,as=`${xr}
const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);

// Shafts: noise around the sun axis, so every shaft converges on the sun.
vec4 abyssSky(vec3 d) {
  vec3 t1 = normalize(cross(SUN, vec3(0.0, 0.0, 1.0)));
  vec3 t2 = cross(SUN, t1);
  float ang = acos(clamp(dot(d, SUN), -1.0, 1.0));
  vec2 around = normalize(vec2(dot(d, t1), dot(d, t2)) + 1e-6);
  vec2 per = vec2(1e4);
  // Shaft pattern: noise on a circle, stretched along the shaft.
  float broad = fbm(vec3(around * 3.2, ang * 0.35), per, 4);
  float fine = fbm(vec3(around * 11.0, ang * 0.6 + 4.0), per, 4);
  float shaftsBroad = smoothstep(0.0, 0.55, broad);
  float shaftsFine = smoothstep(0.05, 0.6, fine);
  // Shafts fade away from the sun and break up along their length.
  float along = 0.6 + 0.4 * fbm(d * 3.0 + vec3(2.0, 7.0, 1.0), per, 3);
  float fade = exp(-ang * 1.15);
  // Caustic net near the surface: ridged noise on the plane above.
  float caustic = 0.0;
  if (d.y > 0.05) {
    vec2 plane = d.xz / d.y;
    caustic = pow(ridged(vec3(plane * 2.4, 0.5), per, 4), 3.0) * smoothstep(0.05, 0.6, d.y);
  }
  float murk = fbm(d * 1.6 + vec3(9.0, 3.0, 5.0), per, 6);
  return vec4(
    shaftsBroad * fade * along,
    caustic,
    murk * 0.5 + 0.5,
    shaftsFine * fade * along
  );
}

// A periodic caustic web: the bright borders of a domain-warped cellular
// pattern with "cells" cells per tile side.
float causticWeb(vec2 st, float cells) {
  vec2 per = vec2(cells);
  vec2 p = st * cells;
  vec2 w = p + 0.38 * vec2(gnoise(vec3(p, 1.3), per), gnoise(vec3(p, 7.1), per));
  vec2 i = floor(w);
  vec2 f = w - i;
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = hash22(mod(i + o, per) + 0.5);
      vec2 r = o + 0.5 + 0.42 * sin(6.2831 * h) - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return exp(-(sqrt(f2) - sqrt(f1)) * 10.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.61);
    float murk = fbm(p, per, 6) * 0.5 + 0.5;
    fragColor = vec4(murk, causticWeb(st, 8.0), causticWeb(st + 0.37, 5.0), 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  fragColor = clamp(abyssSky(d), 0.0, 1.0);
}
`,is=`${xr}
const vec3 SUN = vec3(0.7894, 0.1105, -0.6039);

float cloudDensity(vec3 p, vec2 per) {
  // Offset so the field is not centred on a gap: the sky straight overhead
  // (all a camera below the data sees) carries clouds too.
  p += vec3(4.7, 0.0, 2.3);
  float base = fbm(p * vec3(0.55, 1.4, 0.55), per, 6);
  float detail = fbm(p * 1.9 + vec3(3.0, 1.0, 7.0), per, 4);
  return clamp((base * 0.85 + detail * 0.25 + 0.13) * 2.4, 0.0, 1.0);
}

// The upper clouds: a slab between heights 1.0 and 1.35, ray-marched.
vec2 upperClouds(vec3 d) {
  if (d.y < 0.015) return vec2(0.0, 0.0);
  vec2 per = vec2(1e4);
  float t0 = 1.0 / d.y;
  float t1 = 1.35 / d.y;
  float steps = 10.0;
  float dt = (t1 - t0) / steps;
  float transmittance = 1.0;
  float light = 0.0;
  for (int i = 0; i < 10; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = d * t;
    float far = smoothstep(4.0, 22.0, t);
    float dens = cloudDensity(p * 1.6, per) * (1.0 - far * 0.75);
    if (dens < 0.01) continue;
    float toward = cloudDensity(p * 1.6 + SUN * 0.3, per);
    float lit = exp(-toward * 2.2) * 0.85 + 0.15;
    float absorb = 1.0 - exp(-dens * dt * 7.0);
    light += transmittance * absorb * lit;
    transmittance *= 1.0 - absorb;
    if (transmittance < 0.02) break;
  }
  float opacity = (1.0 - transmittance) * smoothstep(0.015, 0.12, d.y);
  return vec2(opacity, opacity > 1e-3 ? light / (1.0 - transmittance) : 0.0);
}

// Aurora curtains: luminous vertical sheets hanging between two heights,
// whose ground tracks are wavy curves, ray-marched from below so their
// folds and rays read in true perspective. x: emission, y: mean height
// fraction (0 at the bright lower edge, 1 at the top).
vec2 curtains(vec3 d) {
  if (d.y < 0.02) return vec2(0.0);
  vec2 per = vec2(1e4);
  const float BASE = 1.7;
  const float TOP = 3.6;
  float t0 = BASE / d.y;
  float t1 = TOP / d.y;
  float dt = (t1 - t0) / 24.0;
  float glow = 0.0;
  float heightSum = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = d * t;
    float h = (p.y - BASE) / (TOP - BASE);
    float sheet = 0.0;
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float z0 = k == 0 ? -1.4 : (k == 1 ? -5.5 : 4.0);
      float curve = z0
        + 1.5 * sin(p.x * 0.33 + fk * 2.1)
        + 1.3 * fbm(vec3(p.x * 0.22, fk * 4.0, 0.5), per, 2);
      float dist = abs(p.z - curve);
      float width = 0.10 + 0.015 * t;
      float rays = 0.25 + 0.75 * smoothstep(-0.25, 0.6, fbm(vec3(p.x * 5.0 + fk * 9.0, fk * 3.0, h * 0.7), per, 3));
      sheet += exp(-dist * dist / (width * width)) * rays * (1.0 - 0.25 * fk);
    }
    float profile = exp(-h * 2.4) * (1.0 - exp(-h * 30.0));
    float e = sheet * profile * dt;
    glow += e;
    heightSum += e * h;
  }
  float fade = smoothstep(0.02, 0.14, d.y);
  return vec2(clamp(glow * 5.0, 0.0, 1.0) * fade, glow > 1e-4 ? heightSum / glow : 0.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_size;
  if (u_face < 0) {
    // Periodic cloud tile: density, top-lit shading, a second layer.
    vec2 per = vec2(4.0);
    vec3 p = vec3(st * per, 0.29);
    float dens = clamp(fbm(p, per, 7) * 1.9 + 0.12, 0.0, 1.0);
    float lit = clamp(0.55 + (dens - clamp(fbm(p + vec3(0.06, 0.09, 0.0), per, 7) * 1.9 + 0.12, 0.0, 1.0)) * 6.0, 0.0, 1.0);
    float second = clamp(fbm(vec3(st * per * 2.0, 3.7), per * 2.0, 6) * 1.8 + 0.05, 0.0, 1.0);
    fragColor = vec4(dens, lit, second, 1.0);
    return;
  }
  vec3 d = normalize(cubeFaceDir(u_face, st * 2.0 - 1.0));
  vec2 clouds = upperClouds(d);
  vec2 aurora = curtains(d);
  fragColor = vec4(clouds, aurora);
}
`,Mo=`#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invMvp;        // pane NDC -> model space
uniform vec3 u_eye;           // camera, model space
uniform float u_pixelRatio;   // device px per CSS px
uniform vec2 u_viewport;      // pane size, device px
uniform float u_glowCenterX;  // NDC x of the presented area's centre
uniform float u_opacity;      // fade-in 0..1
uniform vec3 u_surface;       // clear colour (sRGB)
uniform float u_planar;       // 1: planar pane (virtual sky camera + near tile)
uniform vec3 u_stageCenter;
uniform vec3 u_stageExtent;
uniform float u_floorY;
uniform float u_time;         // ambient clock, seconds (frozen when still)
uniform float u_ambient;      // 1 while ambient motion runs
uniform float u_dark;         // 1: dark twin
uniform vec3 u_tint0;         // data tints, linear, luminance 1
uniform vec3 u_tint1;
uniform vec3 u_tint2;
out vec4 fragColor;
${aa}
${ia}
${sa}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Soft knee on luminance: large areas can approach but never pass cap.
vec3 kneeLuminance(vec3 c, float cap) {
  float y = luma(c);
  float target = cap * (1.0 - exp(-y / cap));
  return c * (target / max(y, 1e-7));
}
// Light twins: the floor is the mirror image, measured down from white.
vec3 floorLuminance(vec3 c, float floorY) {
  float y = luma(c);
  float lifted = 1.0 - (1.0 - floorY) * (1.0 - exp(-(1.0 - y) / (1.0 - floorY)));
  return c * (max(lifted, 0.0) / max(y, 1e-7));
}
vec3 viewRay() {
  vec4 far = u_invMvp * vec4(v_ndc, 1.0, 1.0);
  return normalize(far.xyz / far.w - u_eye);
}
// 0 at the centre of the presented area, 1 at its corners.
float vignetteRadius() {
  vec2 q = vec2(
    (v_ndc.x - u_glowCenterX) / max(1.0 - u_glowCenterX, 1e-3),
    v_ndc.y
  );
  return clamp(length(q) / 1.41421, 0.0, 1.5);
}
// The planar far layer: the sky seen through a virtual camera that turns
// slowly as the pane pans (yaw with x, a bounded pitch with y) and widens a
// little with zoom, so a pan is seamless forever.
vec3 virtualSkyRay(float pitchBias) {
  float aspect = u_viewport.x / max(u_viewport.y, 1.0);
  float zoom = clamp(pow(max(u_eye.z - u_stageCenter.z, 0.05) / 3.0, 0.12), 0.7, 1.4);
  float tanHalf = 0.42 * zoom;
  vec3 r = normalize(vec3(v_ndc.x * aspect * tanHalf, v_ndc.y * tanHalf, -1.0));
  float yaw = (u_eye.x - u_stageCenter.x) / 9.0;
  float pitch = pitchBias + 0.45 * tanh((u_eye.y - u_stageCenter.y) / 12.0);
  float cp = cos(pitch), sp = sin(pitch);
  // Pitch up: the forward axis (-z) turns toward +y.
  r = vec3(r.x, cp * r.y - sp * r.z, sp * r.y + cp * r.z);
  float cy = cos(yaw), sy = sin(yaw);
  return vec3(cy * r.x + sy * r.z, r.y, -sy * r.x + cy * r.z);
}
// Where the view ray meets the plane z = (back of the data) - depth.
vec2 planarLayer(vec3 ray, float depth) {
  float z = u_stageCenter.z - u_stageExtent.z - depth;
  float rz = abs(ray.z) < 1e-5 ? -1e-5 : ray.z;
  float t = max((z - u_eye.z) / rz, 0.0);
  return (u_eye + ray * t).xy;
}
// A horizon dip: the sky's horizon sits below the eye, as it does from
// altitude, so a camera looking down on the data still sees sky.
vec3 dipped(vec3 d, float k) {
  return normalize(d + vec3(0.0, k, 0.0));
}
// How far a view ray passes from the data, in units of the data's size:
// below 1 the ray crosses the cloud.
float stageMiss(vec3 ray) {
  vec3 toStage = u_stageCenter - u_eye;
  float along = max(dot(toStage, ray), 0.0);
  return length(toStage - ray * along) / (length(u_stageExtent) * 1.05 + 0.15);
}
// Two-hash triangular dither of about one code value.
vec3 dither(vec3 srgb, float amount) {
  float a = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float b = hash12(gl_FragCoord.xy + 71.3);
  return srgb + (a + b - 1.0) * amount / 255.0;
}
vec4 finish(vec3 linear, float grain) {
  vec3 srgb = toSrgb(linear);
  srgb = mix(u_surface, srgb, u_opacity);
  return vec4(dither(srgb, grain), 1.0);
}
// Crisp star cores of one cell layer around a direction, round on screen,
// never narrower than one device pixel.
vec3 starCores(vec3 d, float cells, float probability, float seed, float gain, float pixelAngle, float twinkle) {
  vec2 uv;
  int face = cubeFaceOf(d, uv);
  vec2 cell = floor((uv * 0.5 + 0.5) * cells);
  vec3 sd;
  vec3 star = starInCell(face, cell, cells, probability, seed, sd);
  if (star.x < 0.5) return vec3(0.0);
  float ang = length(sd - d);
  float m = pow(star.y, 3.0);
  float sigma = max(pixelAngle * 0.62, pixelAngle * u_pixelRatio * (0.38 + 0.55 * m));
  float core = exp(-0.5 * ang * ang / (sigma * sigma));
  float flicker = 1.0 + twinkle * 0.45 * sin(u_time * (1.1 + 2.3 * star.z) + 40.0 * star.y);
  return starTint(star.z) * core * (0.08 + m) * gain * flicker;
}
`,ss=`${Mo}
uniform samplerCube u_sky;
uniform sampler2D u_tile;

const vec3 BAND_NORMAL = vec3(0.3283, 0.8536, -0.4048);
const vec3 DEEP = vec3(0.0011, 0.0013, 0.0034);
const vec3 BAND_LIFT = vec3(0.0042, 0.0040, 0.0062);

// Data tints graded toward the classic emission palette (H-alpha rose,
// O-III teal), so a field of warm colours never turns the sky to mud.
vec3 grade(vec3 tint, vec3 cosmic) {
  vec3 t = mix(tint, cosmic, 0.5);
  return t / max(luma(t), 1e-3);
}

// detail: fine fBm evaluated per fragment, finer than the cube's texels, so
// the clouds stay crisp at 4K and DPR 2 (-1..1, faded out where it would alias).
vec3 nebulaColour(vec4 s, float band, float detail) {
  float a = s.r * (1.0 + 0.45 * detail);
  float b = s.g * 2.0 * (1.0 + 0.6 * detail);
  float dust = clamp(s.b * (1.0 - 0.35 * detail), 0.0, 1.0);
  vec3 t0 = grade(u_tint0, vec3(1.0, 0.32, 0.45) / 0.49);
  vec3 t1 = grade(u_tint1, vec3(0.25, 0.75, 1.0) / 0.66);
  vec3 t2 = grade(u_tint2, vec3(0.75, 0.55, 1.0) / 0.62);
  vec3 col = DEEP + BAND_LIFT * band * (1.0 - 0.8 * dust);
  vec3 emission = t0 * (a * 0.012 + a * a * 0.060)
    + t1 * (b * 0.010 + b * b * 0.042)
    + t2 * a * b * 0.034
    + vec3(1.0, 0.95, 0.92) * pow(a * b, 2.0) * 0.050;
  emission *= 1.0 - 0.92 * dust;
  col *= 1.0 - 0.6 * dust;
  col += emission;
  return kneeLuminance(col, 0.042);
}

// Fine filament structure below the cube's resolution: two octaves of
// gradient noise on the sphere, faded out where a pixel spans an octave.
float nebulaDetail(vec3 d, float pixelAngle) {
  vec2 per = vec2(1e4);
  float n = gnoise(d * 22.0 + vec3(3.1, 1.7, 5.3), per) * 0.65
    + gnoise(d * 47.0 + vec3(9.2, 4.4, 0.6), per) * 0.35 * (1.0 - smoothstep(0.004, 0.012, pixelAngle));
  return n * (1.0 - smoothstep(0.012, 0.04, pixelAngle));
}

vec3 nebulaStars(vec3 d, float band, float pixelAngle, float twinkle) {
  return starCores(d, 40.0, 0.05 + 0.16 * band, 3.0, 1.0, pixelAngle, twinkle)
    + starCores(d, 130.0, 0.05 + 0.12 * band, 11.0, 0.22, pixelAngle, twinkle)
    + starCores(d, 360.0, 0.03 + 0.20 * band, 23.0, 0.05, pixelAngle * 1.4, 0.0);
}

void main() {
  vec3 ray = viewRay();
  float twinkle = u_ambient;
  // Stars dim behind the data cloud, so no star can pass for a cell.
  float behind = mix(0.35, 1.0, smoothstep(0.55, 1.5, stageMiss(ray)));
  vec3 col;
  if (u_planar < 0.5) {
    float pixelAngle = max(length(fwidth(ray)), 1e-6);
    vec3 d = ray;
    vec4 s = texture(u_sky, d);
    float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
    col = nebulaColour(s, band, nebulaDetail(d, pixelAngle));
    // Near layer: a dust shell around the stage, which slides against the
    // sky as the camera moves.
    vec3 oc = u_eye - u_stageCenter;
    float radius = max(7.5, length(u_stageExtent) * 3.0);
    float bq = dot(oc, ray);
    float cq = dot(oc, oc) - radius * radius;
    float disc = bq * bq - cq;
    if (disc > 0.0) {
      float t = -bq + sqrt(disc);
      vec3 shell = normalize(oc + ray * t);
      vec4 near = texture(u_sky, vec3(shell.z, shell.x, -shell.y));
      float wisp = smoothstep(0.3, 0.9, near.b) * (0.4 + 0.6 * near.r);
      col *= 1.0 - 0.45 * wisp;
    }
    float glow = s.a / max(1.0 - s.a, 1e-3);
    col += kneeLuminance(vec3(0.85, 0.90, 1.0) * glow * 0.020, 0.045) * behind;
    col += nebulaStars(d, band, pixelAngle, twinkle) * behind;
  } else {
    // Far: the sky through the virtual camera. Near: wisps and stars on a
    // plane behind the data, with true parallax.
    vec3 d = virtualSkyRay(0.0);
    float skyPixel = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    float band = exp(-pow(dot(d, BAND_NORMAL) / 0.34, 2.0));
    col = nebulaColour(s, band, nebulaDetail(d, skyPixel));
    float glow = s.a / max(1.0 - s.a, 1e-3);
    col += kneeLuminance(vec3(0.85, 0.90, 1.0) * glow * 0.020, 0.045) * behind;
    col += (starCores(d, 40.0, 0.05 + 0.16 * band, 3.0, 1.0, skyPixel, twinkle)
      + starCores(d, 130.0, 0.05 + 0.12 * band, 11.0, 0.22, skyPixel, twinkle)) * behind;
    vec2 nearUv = planarLayer(ray, 2.6) / 7.0;
    vec4 tile = texture(u_tile, nearUv);
    float wisp = smoothstep(0.3, 0.95, tile.b);
    col *= 1.0 - 0.40 * wisp;
    col += grade(u_tint0, vec3(1.0, 0.32, 0.45) / 0.49) * 0.0035 * smoothstep(0.4, 1.0, tile.r) * (1.0 - wisp);
    // Near stars on the same plane: cells in plane units.
    vec2 p = planarLayer(ray, 2.6) * 6.0;
    float px = max(length(fwidth(p)), 1e-6);
    vec2 cell = floor(p);
    float h = hash12(cell + 7.0);
    if (h < 0.05) {
      vec2 centre = cell + 0.25 + 0.5 * hash22(cell + 3.0);
      float m = pow(hash12(cell + 13.0), 3.0);
      float sigma = max(px * 0.62, px * u_pixelRatio * (0.4 + 0.5 * m));
      float dist = length(p - centre);
      float flicker = 1.0 + twinkle * 0.45 * sin(u_time * (1.3 + 24.0 * h) + 9.0 * m);
      col += starTint(hash12(cell + 29.0)) * exp(-0.5 * dist * dist / (sigma * sigma)) * (0.06 + 0.6 * m) * flicker * behind;
    }
  }
  // Vignette: the frame falls off toward its corners.
  float v = vignetteRadius();
  col *= 1.0 - 0.55 * smoothstep(0.35, 1.15, v);
  fragColor = finish(col, 1.0);
}
`,cs=`${Mo}
uniform sampler2D u_shadow;    // r: cast shadow, g: ambient occlusion, 0..1
uniform vec3 u_shadowWindow;   // centre u, centre v, half size
uniform float u_shadowReady;
uniform vec3 u_keyLight;       // toward the key light, unit
uniform float u_paperGap;

const vec3 PAPER = vec3(0.880, 0.858, 0.822);   // warm paper
const vec3 KEY = vec3(1.0, 0.962, 0.900);
const vec3 FILL = vec3(0.925, 0.950, 1.0);

vec2 shadowAt(vec2 uv) {
  vec2 st = (uv - u_shadowWindow.xy) / (2.0 * u_shadowWindow.z) + 0.5;
  float inside = smoothstep(0.0, 0.04, st.x) * smoothstep(0.0, 0.04, st.y)
    * smoothstep(1.0, 0.96, st.x) * smoothstep(1.0, 0.96, st.y);
  return texture(u_shadow, st).rg * inside * u_shadowReady;
}

// Paper tooth anchored to the surface: fades out before it can alias.
float paperGrain(vec2 uv) {
  vec2 p = uv * 190.0;
  float footprint = length(fwidth(p));
  float fibres = gnoise(vec3(p * vec2(1.0, 0.35), 0.5), vec2(1e4)) * 0.6
    + gnoise(vec3(p * 2.3, 2.5), vec2(1e4)) * 0.4;
  return fibres * (1.0 - smoothstep(0.35, 0.9, footprint));
}

// A shadowed patch of paper: darker, and cooler (lit by the fill only).
vec3 applyShadow(vec3 c, vec2 s) {
  float occlusion = clamp(0.30 * s.r + 0.20 * s.g, 0.0, 0.42);
  vec3 shaded = c * mix(vec3(1.0), vec3(0.97, 0.985, 1.0), smoothstep(0.0, 0.3, occlusion));
  return shaded * (1.0 - occlusion);
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  float reach = max(max(u_stageExtent.x, u_stageExtent.z), 0.6) * 2.4;
  if (u_planar < 0.5) {
    // An infinite cyclorama: the floor sweeps up into the wall at the
    // horizon with no edge; both meet the same horizon colour.
    float height = u_eye.y - u_floorY;
    float rise = clamp(ray.y, -1.0, 1.0);
    vec2 keyDir = normalize(u_keyLight.xz + 1e-5);
    vec2 heading = normalize(ray.xz + 1e-5);
    float keySide = 0.5 + 0.5 * dot(heading, keyDir);
    vec3 horizon = PAPER * mix(FILL, KEY, keySide) * 0.90;
    // The wall: a soft key-lit sweep, brightest low on the key side, falling
    // off upward (and, seen from below the floor, downward) into a cool top.
    float sweep = exp(-pow((abs(rise) - 0.12) / 0.45, 2.0));
    float keyLobe = pow(max(dot(heading, keyDir), 0.0), 3.0);
    vec3 wall = horizon * (0.93 + 0.07 * sweep + 0.07 * keyLobe * sweep)
      * mix(vec3(1.0), FILL * 0.86, smoothstep(0.1, 1.0, abs(rise)));
    col = wall;
    // The floor point, and its grain, in uniform control flow so the
    // grain's derivatives are defined.
    float t = min(abs(height) / max(abs(rise), 1e-4), 1e4);
    vec2 uv = (u_eye + ray * t).xz;
    float grain = paperGrain(uv);
    if (rise < 0.0 && height > 0.0) {
      // A key pool on the floor, off-centre toward the light, falling away
      // to the horizon tone; the side away from the key is cooler.
      vec2 poolCentre = u_stageCenter.xz + u_keyLight.xz * reach * 0.35;
      vec2 offset = uv - poolCentre;
      float pool = exp(-dot(offset, offset) / (reach * reach));
      float wide = exp(-dot(offset, offset) / (reach * reach * 9.0));
      float side = dot(normalize(offset + 1e-5), keyDir) * smoothstep(0.0, reach, length(offset));
      vec3 lightColour = mix(FILL, KEY, 0.55 + 0.45 * side);
      vec3 floorColour = PAPER * lightColour * (0.86 + 0.08 * wide + 0.12 * pool);
      floorColour = applyShadow(floorColour, shadowAt(uv));
      floorColour *= 1.0 + 0.010 * grain;
      // The cove: the floor blends into the horizon colour as it nears
      // grazing, so floor and wall meet without an edge.
      float cove = 1.0 - smoothstep(0.0, 0.30, -rise);
      col = mix(floorColour, horizon, cove);
    } else if (rise > 0.0 && height < 0.0) {
      // Below the stage, looking up: the floor is a sheet of paper lit from
      // above, glowing through, with the data's shadow showing through it as
      // a soft, cool silhouette.
      vec2 offset = uv - (u_stageCenter.xz + u_keyLight.xz * reach * 0.35);
      float glowPool = exp(-dot(offset, offset) / (reach * reach * 2.2));
      vec3 backlit = PAPER * mix(vec3(1.0), KEY, 0.6) * (0.93 + 0.11 * glowPool);
      vec2 s = shadowAt(uv);
      float through = clamp(0.24 * s.r + 0.12 * s.g, 0.0, 0.32);
      backlit = mix(backlit, backlit * FILL * 0.92, smoothstep(0.0, 0.25, through));
      backlit *= 1.0 - through;
      backlit *= 1.0 + 0.012 * grain;
      float cove = 1.0 - smoothstep(0.0, 0.30, rise);
      col = mix(backlit, horizon, cove);
    }
  } else {
    // Paper behind the data with true parallax; the data hovers above it.
    vec2 uv = planarLayer(ray, u_paperGap);
    float grain = paperGrain(uv * 0.8);
    float extent = max(max(u_stageExtent.x, u_stageExtent.y), 0.6);
    vec2 centre = u_stageCenter.xy + vec2(-0.30, 0.38) * extent;
    vec2 offset = (uv - centre) / extent;
    float pool = exp(-dot(offset, offset) / 2.2);
    float wide = exp(-dot(offset, offset) / 14.0);
    vec2 keyDir = normalize(vec2(-0.45, 0.55));
    float side = dot(normalize(offset + 1e-5), keyDir) * smoothstep(0.0, 2.0, length(offset));
    col = PAPER * mix(FILL, KEY, 0.55 + 0.45 * side) * (0.86 + 0.08 * wide + 0.11 * pool);
    col = applyShadow(col, shadowAt(uv));
    col *= 1.0 + 0.012 * grain;
  }
  float v = vignetteRadius();
  col *= 1.0 - 0.07 * smoothstep(0.3, 1.2, v);
  col = floorLuminance(col, 0.62);
  // Fine paper grain over the whole frame doubles as the anti-banding dither.
  fragColor = finish(col, 1.6);
}
`,ls=`${Mo}
uniform samplerCube u_sky;     // r: broad shafts, g: caustics, b: murk, a: fine shafts
uniform sampler2D u_tile;      // r: murk, g: caustics (periodic)

const vec3 SUN = vec3(0.2357, 0.9428, 0.2357);
const float DIP = 0.55;

vec3 water(vec3 d, vec4 s, float planarMurk) {
  float rise = d.y;
  vec3 top, horizon, depth, shaftColour, causticColour;
  if (u_dark > 0.5) {
    top = vec3(0.012, 0.050, 0.068);
    horizon = vec3(0.0035, 0.0160, 0.0250);
    depth = vec3(0.0005, 0.0018, 0.0036);
    shaftColour = vec3(0.020, 0.080, 0.085);
    causticColour = vec3(0.012, 0.050, 0.050);
  } else {
    top = vec3(0.90, 0.98, 0.96);
    horizon = vec3(0.56, 0.81, 0.83);
    depth = vec3(0.40, 0.69, 0.74);
    shaftColour = vec3(0.36, 0.28, 0.18);
    causticColour = vec3(0.20, 0.17, 0.12);
  }
  vec3 col = rise > 0.0
    ? mix(horizon, top, pow(smoothstep(0.0, 1.0, rise), 0.7))
    : mix(horizon, depth, smoothstep(0.0, 0.75, -rise));
  float murk = mix(s.b, planarMurk, u_planar);
  col *= 0.84 + 0.32 * murk;
  float shafts = s.r * 0.85 + s.a * 0.6;
  shafts *= smoothstep(-0.55, 0.15, rise);
  float sunAngle = acos(clamp(dot(d, SUN), -1.0, 1.0));
  float sunGlow = exp(-sunAngle * sunAngle / 0.20);
  if (u_dark > 0.5) {
    col += shaftColour * shafts;
    col += causticColour * s.g;
    col += shaftColour * 0.7 * sunGlow;
    col = kneeLuminance(col, 0.046);
  } else {
    col += shaftColour * shafts * 0.40;
    col += causticColour * s.g * 0.8;
    // The sunlit surface overhead, rippled: darker troughs between the
    // bright caustic crests.
    col = mix(col, col * vec3(0.84, 0.93, 0.96), (1.0 - s.g) * smoothstep(0.25, 0.8, rise) * 0.55);
    col += vec3(0.14, 0.10, 0.05) * sunGlow;
    col = floorLuminance(col, 0.62);
  }
  return col;
}

// Sunlit shallows only: a sandy floor below the stage under a caustic web,
// sliding with true parallax and fading into turquoise water.
vec3 sandFloor(vec2 uv, float distance, vec3 waterColour) {
  // Two baked web layers (tile .g and .b) drifting against each other.
  float drift = u_time * 0.02;
  float caustic = texture(u_tile, uv * 1.3 / 8.0 + vec2(drift, 0.3 * drift)).g * 0.65
    + texture(u_tile, uv * 2.3 / 5.0 + vec2(0.37 - 0.7 * drift, drift)).b * 0.35;
  float ripple = texture(u_tile, uv / 6.0).r;
  vec3 sand = vec3(0.94, 0.86, 0.70) * (0.92 + 0.10 * ripple);
  vec3 lit = sand + vec3(0.18, 0.18, 0.14) * pow(caustic, 1.5);
  // Shallow water over the sand: a light turquoise cast, deepening with distance.
  lit *= vec3(0.90, 0.98, 0.97);
  float fog = 1.0 - exp(-distance / 11.0);
  return mix(lit, waterColour, clamp(fog, 0.0, 1.0));
}

vec3 seaFloor(vec3 ray, vec3 waterColour) {
  // The sand lies under the stage, and sinks under a camera that dives
  // below the data, so there is always a sea floor beneath the viewer.
  float floorY = min(u_floorY - 1.2, u_eye.y - 1.2);
  if (u_dark > 0.5 || ray.y >= -0.01) return waterColour;
  float t = (floorY - u_eye.y) / ray.y;
  vec2 uv = (u_eye + ray * t).xz;
  return sandFloor(uv, t, waterColour);
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  vec3 tint = u_tint0 * 0.6 + u_tint1 * 0.4;
  tint /= max(luma(tint), 1e-3);
  if (u_planar < 0.5) {
    vec3 d = dipped(ray, DIP);
    vec4 s = texture(u_sky, d);
    col = water(d, s, 0.5);
    col = seaFloor(ray, col);
  } else {
    // Looking up toward the surface, where the rays converge.
    vec3 d = virtualSkyRay(0.85);
    vec4 s = texture(u_sky, d);
    vec2 near = planarLayer(ray, 3.5) / 9.0;
    vec4 tile = texture(u_tile, near);
    col = water(d, s, tile.r);
    if (u_dark > 0.5) {
      float ca = texture(u_tile, planarLayer(ray, 1.2) / 3.0).b;
      float fromTop = smoothstep(-1.2, 1.0, v_ndc.y);
      col += vec3(0.004, 0.018, 0.018) * ca * fromTop;
    } else {
      // Looking straight down into the shallows: sand under the data.
      vec2 sand = planarLayer(ray, 1.4);
      float depth = max(u_eye.z - (u_stageCenter.z - u_stageExtent.z - 1.4), 0.5);
      col = sandFloor(sand, depth * 0.6, col);
    }
  }
  // A faint bioluminescent haze behind the data, in the data's own hues.
  float miss = stageMiss(ray);
  float haze = exp(-miss * miss * 1.4);
  if (u_dark > 0.5) {
    col += mix(vec3(0.010, 0.040, 0.042), tint * 0.022, 0.5) * haze * 0.6;
  } else {
    col = mix(col, col * mix(vec3(1.0), tint, 0.08), haze * 0.7);
  }
  float v = vignetteRadius();
  col *= 1.0 - (u_dark > 0.5 ? 0.6 : 0.08) * smoothstep(0.3, 1.2, v);
  fragColor = finish(col, u_dark > 0.5 ? 1.0 : 1.4);
}
`,fs=`${Mo}
uniform samplerCube u_sky;    // r: cloud opacity, g: cloud lit, b: curtain, a: curtain height
uniform sampler2D u_tile;     // r: cloud density, g: top-lit, b: second layer

const vec3 SUN = vec3(0.7894, 0.1105, -0.6039);
const float DIP = 0.55;

vec3 sky(vec3 d, vec4 s, float pixelAngle, float behind) {
  float rise = d.y;
  float sunAngle = acos(clamp(dot(d, SUN), -1.0, 1.0));
  vec3 col;
  if (u_dark > 0.5) {
    vec3 zenith = vec3(0.0010, 0.0017, 0.0050);
    vec3 horizon = vec3(0.0055, 0.0085, 0.0165);
    col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, abs(rise)), 0.6));
    // Moon haze where the sun would be.
    col += vec3(0.010, 0.013, 0.020) * exp(-sunAngle / 0.35);
    // Stars, hidden behind clouds and fading into the horizon haze.
    float starVis = (1.0 - 0.6 * s.r) * smoothstep(0.02, 0.25, rise) * behind;
    col += starCores(d, 120.0, 0.14, 41.0, 0.22, pixelAngle, u_ambient) * starVis;
    col += starCores(d, 44.0, 0.10, 7.0, 0.85, pixelAngle, u_ambient) * starVis;
    // The curtains: green at the foot, violet into the top; the data's
    // hue nudges the green.
    vec3 green = mix(vec3(0.020, 0.115, 0.060), u_tint0 * 0.08, 0.2);
    vec3 violet = mix(vec3(0.055, 0.018, 0.090), u_tint1 * 0.06, 0.2);
    vec3 aurora = mix(green, violet, smoothstep(0.12, 0.55, s.a)) * s.b * 1.8;
    // Airglow: a faint green band along the horizon under the curtains.
    col += vec3(0.002, 0.007, 0.004) * exp(-abs(rise) / 0.08);
    // Night clouds are thin veils: the curtains show through them.
    float veil = s.r * 0.6;
    col += aurora * (1.0 - 0.6 * veil);
    // Night clouds: dark, rimmed by aurora light.
    vec3 cloud = vec3(0.0028, 0.0038, 0.0068) + green * 0.22 * s.g;
    col = mix(col, cloud, veil * 0.85);
    col = kneeLuminance(col, 0.046);
  } else {
    vec3 zenith = vec3(0.50, 0.65, 0.92);
    vec3 horizon = vec3(1.0, 0.82, 0.66);
    col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, max(rise, 0.0)), 0.5));
    // A rose band just above the horizon, as at dawn.
    col += vec3(0.10, 0.015, 0.06) * exp(-pow((rise - 0.10) / 0.09, 2.0));
    // Sun haze: a wide warm bloom and a soft core.
    col += vec3(0.30, 0.15, 0.03) * exp(-sunAngle / 0.38);
    col += vec3(0.30, 0.24, 0.14) * exp(-sunAngle * sunAngle / 0.004);
    // Clouds lit pink-gold on the sun side, lavender in their shade.
    float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(SUN.xz));
    vec3 litColour = mix(vec3(1.0, 0.96, 0.97), vec3(1.0, 0.85, 0.70), sunSide * sunSide);
    vec3 shadeColour = vec3(0.62, 0.62, 0.80);
    vec3 cloud = mix(shadeColour, litColour, smoothstep(0.15, 0.85, s.g));
    col = mix(col, cloud, clamp(s.r * 1.25, 0.0, 0.95));
    col = floorLuminance(col, 0.62);
  }
  return col;
}

// The sea of clouds below the horizon: two world-anchored tiles on planes
// under the stage, so it slides with parallax; it melts into the haze.
vec3 cloudSea(vec3 d, vec3 haze) {
  // Under the stage, and always under the camera: seen from below the data
  // the sea of clouds stays below the horizon.
  float seaY = min(u_floorY - 2.5, u_eye.y - 2.0);
  float drop = max(u_eye.y - seaY, 0.5);
  float t = drop / max(-d.y, 1e-3);
  vec2 uv = u_eye.xz + d.xz * t;
  vec4 a = texture(u_tile, uv / 14.0);
  vec4 b = texture(u_tile, uv / 5.5 + 0.31);
  float dens = smoothstep(0.18, 0.70, a.r * 0.75 + b.b * 0.35);
  float lit = mix(a.g, b.g, 0.35);
  float fog = 1.0 - exp(-t / 26.0);
  vec3 col;
  if (u_dark > 0.5) {
    vec3 gap = vec3(0.0016, 0.0024, 0.0052);
    vec3 top = vec3(0.0050, 0.0085, 0.0125) + vec3(0.003, 0.020, 0.011) * lit;
    col = mix(gap, top, dens);
  } else {
    vec3 gap = vec3(0.64, 0.68, 0.84);
    float sunSide = 0.5 + 0.5 * dot(normalize(d.xz + 1e-5), normalize(SUN.xz));
    vec3 top = mix(vec3(0.76, 0.75, 0.86), mix(vec3(1.0, 0.96, 0.94), vec3(1.0, 0.88, 0.76), sunSide), smoothstep(0.2, 0.8, lit));
    col = mix(gap, top, dens);
  }
  return mix(col, haze, clamp(fog, 0.0, 1.0));
}

void main() {
  vec3 ray = viewRay();
  vec3 col;
  float behind = mix(0.35, 1.0, smoothstep(0.55, 1.5, stageMiss(ray)));
  if (u_planar < 0.5) {
    vec3 d = dipped(ray, DIP);
    float pixelAngle = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    vec3 skyColour = sky(d, s, pixelAngle, behind);
    if (d.y >= 0.0) {
      col = skyColour;
    } else {
      vec3 horizonDir = normalize(vec3(d.x, 0.004, d.z));
      vec3 haze = sky(horizonDir, texture(u_sky, horizonDir), pixelAngle, 0.0);
      col = cloudSea(d, haze);
    }
  } else {
    vec3 d = virtualSkyRay(0.30);
    float pixelAngle = max(length(fwidth(d)), 1e-6);
    vec4 s = texture(u_sky, d);
    col = sky(d, s, pixelAngle, behind);
    // A drifting cloud layer on a plane behind the data.
    vec2 near = planarLayer(ray, 3.2) / 8.0;
    vec4 tile = texture(u_tile, near);
    float dens = smoothstep(0.42, 0.95, tile.r) * smoothstep(-1.1, 0.4, v_ndc.y);
    vec3 cloud = u_dark > 0.5
      ? vec3(0.0035, 0.0050, 0.0085) + vec3(0.002, 0.014, 0.008) * tile.g
      : mix(vec3(0.78, 0.77, 0.85), vec3(1.0, 0.94, 0.89), tile.g);
    col = mix(col, cloud, dens * 0.55);
  }
  float v = vignetteRadius();
  col *= 1.0 - (u_dark > 0.5 ? 0.5 : 0.07) * smoothstep(0.3, 1.2, v);
  fragColor = finish(col, u_dark > 0.5 ? 1.0 : 1.4);
}
`,us=`#version 300 es
precision highp float;
layout(location = 0) in vec4 a_seed;   // xyz: -1..1, w: 0..1 (population, size)
uniform mat4 u_mvp;
uniform vec3 u_eye;
uniform vec3 u_stageCenter;
uniform vec3 u_stageExtent;
uniform float u_projScale;     // projection[5]
uniform float u_viewportHeight;
uniform float u_pixelRatio;
uniform float u_time;
uniform float u_planar;
uniform float u_maxPointSize;
uniform vec4 u_ndcTransform;   // pane NDC = raster NDC * xy + zw (see COMMON_VS)
out float v_glow;
out float v_alpha;
out float v_hue;
out float v_blur;
void main() {
  vec3 ext = max(u_stageExtent, vec3(0.25));
  vec3 pos;
  float attendant = step(a_seed.w, 0.28);
  float drift = u_time * (0.010 + 0.012 * fract(a_seed.w * 7.0));
  float boxFade = 1.0;
  if (attendant > 0.5) {
    // Attendants: a loose shell hugging the data cloud.
    vec3 dir = normalize(a_seed.xyz + 1e-4);
    float r = 0.9 + 0.9 * fract(a_seed.w * 13.7);
    pos = u_stageCenter + dir * ext * r * 1.2;
    pos.y -= mod(drift, 0.6) - 0.3;
  } else {
    // Ambient: a box that wraps around the camera, so the snow never ends.
    float box = 12.0;
    vec3 p = a_seed.xyz * box * 0.5;
    p.y -= drift * 3.0;
    vec3 rel = mod(p - u_eye + box * 0.5, box) - box * 0.5;
    pos = u_eye + rel;
    boxFade = 1.0 - smoothstep(0.30, 0.5, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)) / box);
  }
  if (u_planar > 0.5) {
    // Keep planar snow behind the data plane.
    float back = u_stageCenter.z - u_stageExtent.z - 0.15;
    pos.z = min(pos.z, back - 0.05 - 3.0 * fract(a_seed.w * 31.3));
  }
  vec4 clip = u_mvp * vec4(pos, 1.0);
  float worldSize = 0.006 + 0.012 * fract(a_seed.w * 53.1);
  float size = worldSize * u_projScale * u_viewportHeight * 0.5 / max(clip.w, 1e-3);
  float minimum = 1.0 * u_pixelRatio;
  float device = max(size, minimum);
  // Near motes turn into soft bokeh: bigger, blurrier, fainter.
  float blur = smoothstep(1.6, 0.3, clip.w);
  float bokeh = device * (1.0 + 5.0 * blur);
  float drawn = min(bokeh * 2.6, u_maxPointSize);
  gl_PointSize = drawn;
  // Into the target's own clip space (identity on screen).
  gl_Position = vec4((clip.xy - u_ndcTransform.zw * clip.w) / u_ndcTransform.xy, clip.zw);
  // Energy kept roughly constant as a mote grows; dimmed when below 1 px.
  float coverage = clamp(size / minimum, 0.2, 1.0) * (device * device) / (bokeh * bokeh);
  vec3 rel = (pos - u_stageCenter) / (ext * 1.1 + 0.15);
  float spread = length(rel);
  v_glow = exp(-max(spread - 0.8, 0.0) * 2.2);
  float tooNear = smoothstep(0.12, 0.45, clip.w);
  v_alpha = coverage * tooNear * boxFade * (clip.w > 0.0 ? 1.0 : 0.0);
  v_hue = fract(a_seed.w * 97.3);
  v_blur = blur;
}
`,ds=`#version 300 es
precision highp float;
in float v_glow;
in float v_alpha;
in float v_hue;
in float v_blur;
uniform float u_dark;
uniform float u_opacity;
uniform vec3 u_tint0;
uniform vec3 u_tint1;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c) * 6.76;     // sprite is 2.6x the mote
  float sharpness = mix(2.2, 0.55, v_blur);
  float core = exp(-r2 * sharpness);
  float halo = exp(-r2 * 0.35) * 0.25;
  vec3 tint = mix(u_tint0, u_tint1, step(0.5, v_hue));
  tint /= max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  if (u_dark > 0.5) {
    // Additive light: faint cyan snow that blooms in the data's hues
    // near the cloud.
    vec3 snow = vec3(0.09, 0.20, 0.22);
    vec3 bloom = mix(vec3(0.15, 0.85, 0.85), tint * 0.5, 0.55);
    vec3 col = snow * core * 0.32 + bloom * (core + halo) * v_glow * 0.22;
    fragColor = vec4(sqrt(col) * 0.55 * v_alpha * u_opacity, 1.0);
  } else {
    // Sunlit specks: soft and slightly darker; near the data they catch its hue.
    vec3 speck = mix(vec3(0.42, 0.56, 0.57), sqrt(tint * 0.25), v_glow * 0.6);
    float a = (core * 0.22 + halo * 0.10 * v_glow) * v_alpha * u_opacity;
    fragColor = vec4(speck * a, a);
  }
}
`,ca=Object.freeze({"bake:nebula":Object.freeze({vs:_t,fs:ns}),"bake:abyss":Object.freeze({vs:_t,fs:as}),"bake:aurora":Object.freeze({vs:_t,fs:is}),"draw:nebula":Object.freeze({vs:_t,fs:ss}),"draw:atelier":Object.freeze({vs:_t,fs:cs}),"draw:abyss":Object.freeze({vs:_t,fs:ls}),"draw:aurora":Object.freeze({vs:_t,fs}),"draw:motes":Object.freeze({vs:us,fs:ds})});var yr=9,To=10,zt=11,ps=Object.freeze([1,1,0,0]),ms=8,gr=Symbol("wait"),fa=131072,bs=1024,xs=128,ys=16,gs=2e3,yt=512,wr=3200,ua=Object.freeze({nebula:{bake:"bake:nebula",draw:"draw:nebula",cube:"byte",tile:!0},atelier:{bake:null,draw:"draw:atelier",cube:null,tile:!1},abyss:{bake:"bake:abyss",draw:"draw:abyss",cube:"byte",tile:!0,motes:!0},aurora:{bake:"bake:aurora",draw:"draw:aurora",cube:"byte",tile:!0}});function So(e){let o=So.f32??=new Float32Array(1),t=So.u32??=new Uint32Array(o.buffer);o[0]=e;let r=t[0],n=r>>>16&32768,i=(r>>>23&255)-127+15,s=r&8388607;if(i<=0)return i<-10?n:(s=(s|8388608)>>1-i,n|s+4096>>13);if(i>=31)return n|31744;let h=s+4096;return h&8388608?(i+=1,i>=31?n|31744:n|i<<10):n|i<<10|h>>13}a(So,"halfFromFloat");var da=64;function*vr(e,o,t,r,n){if(t<1)return;let i=t*2+1;for(let s=0;s<r;s++){for(let h=0;h<o;h++){let c=h*o,f=0;for(let d=-t;d<=t;d++)f+=e[c+Math.min(o-1,Math.max(0,d))];for(let d=0;d<o;d++){n[c+d]=f/i;let l=Math.min(o-1,d+t+1),m=Math.max(0,d-t);f+=e[c+l]-e[c+m]}(h+1)%da===0&&(yield)}for(let h=0;h<o;h++){let c=0;for(let f=-t;f<=t;f++)c+=n[Math.min(o-1,Math.max(0,f))*o+h];for(let f=0;f<o;f++){e[f*o+h]=c/i;let d=Math.min(o-1,f+t+1),l=Math.max(0,f-t);c+=n[d*o+h]-n[l*o+h]}(h+1)%da===0&&(yield)}}}a(vr,"boxBlur");function ws(e){if(!(e instanceof Uint8Array))return 0;let o=new Uint32Array(e.buffer,e.byteOffset,e.byteLength>>>2),t=2166136261^e.length;for(let r=0;r<o.length;r++)t=Math.imul(t^o[r],16777619);for(let r=o.length*4;r<e.length;r++)t=Math.imul(t^e[r],16777619);return t>>>0}a(ws,"visibilitySignature");function ha(e,{invalidate:o,requestFrame:t,prefersReducedMotion:r,readViewSource:n}){let i=a(()=>performance.now(),"now"),s=e.getExtension("KHR_parallel_shader_compile"),h=Math.min(64,e.getParameter(e.ALIASED_POINT_SIZE_RANGE)[1]||64),c=!1,f=null,d=0,l=1,m=!1,w=null,y=0,x=0,S=!1,A=0,g=new Map,_=new Map,k=new Map,v=[],z=[],F=null,L=null,R={slices:0,maxSliceMs:0,totalMs:0};function C(){F!==null||c||(typeof requestIdleCallback=="function"?(L="idle",F=requestIdleCallback(D,{timeout:120})):(L="timeout",F=setTimeout(D,4)))}a(C,"scheduleSlice");function P(){F!==null&&(L==="idle"?cancelIdleCallback(F):clearTimeout(F),F=null)}a(P,"cancelSlice");function D(){if(F=null,c||v.length===0)return;let u=i(),p=!1;for(;v.length>0;){let E=v[0],O=i(),N;try{N=E.iterator.next()}catch(ce){v.shift(),console.error(`[backdrop-looks] ${E.name} failed:`,ce);continue}let H=i()-O;if(E.cpuMs+=H,E.units+=1,H>E.maxUnitMs&&(E.maxUnitMs=H,E.maxUnitStage=E.stage),!N.done&&N.value===gr){p=!0;break}if(N.done&&(v.shift(),E.doneAt=i(),z.push({name:E.name,units:E.units,cpuMs:+E.cpuMs.toFixed(2),maxUnitMs:+E.maxUnitMs.toFixed(2),maxUnitStage:E.maxUnitStage,wallMs:+(E.doneAt-E.startedAt).toFixed(1)}),z.length>40&&z.shift()),i()-u>=ms)break}let b=i()-u;R.slices+=1,R.totalMs+=b,R.maxSliceMs=Math.max(R.maxSliceMs,b),v.length>0&&(p?(L="timeout",F=setTimeout(D,1)):C())}a(D,"runSlice");function B(u,p,b=!1){let E={name:u,iterator:null,cpuMs:0,units:0,maxUnitMs:0,maxUnitStage:null,stage:"start",startedAt:i(),doneAt:null,cancelled:!1};return E.iterator=p(E),b?v.unshift(E):v.push(E),C(),E}a(B,"enqueue");function I(u){if(u==null)return;u.cancelled=!0;let p=v.indexOf(u);p>=0&&v.splice(p,1)}a(I,"cancelJob");let $=e.createVertexArray(),U=e.createBuffer();e.bindVertexArray($),e.bindBuffer(e.ARRAY_BUFFER,U),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null);let X=null,ne=null;function ye(){if(X!==null)return;let u=new Float32Array(wr*4),p=1234567,b=a(()=>(p=Math.imul(p^p>>>15,2246822507)^Math.imul(p^p>>>13,3266489909),p^=p>>>16,(p>>>0)/4294967296),"random");for(let E=0;E<wr;E++)u[E*4]=b()*2-1,u[E*4+1]=b()*2-1,u[E*4+2]=b()*2-1,u[E*4+3]=b();X=e.createVertexArray(),ne=e.createBuffer(),e.bindVertexArray(X),e.bindBuffer(e.ARRAY_BUFFER,ne),e.bufferData(e.ARRAY_BUFFER,u,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,4,e.FLOAT,!1,0,0),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),A+=u.byteLength}a(ye,"ensureMotes");let V=br(e);function le(){return{framebuffer:e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),viewport:V.viewport,program:e.getParameter(e.CURRENT_PROGRAM),vao:e.getParameter(e.VERTEX_ARRAY_BINDING),blend:V.isEnabled(e.BLEND),depth:V.isEnabled(e.DEPTH_TEST),scissor:V.isEnabled(e.SCISSOR_TEST),scissorBox:V.scissorBox,cull:V.isEnabled(e.CULL_FACE),activeTexture:V.activeTexture}}a(le,"saveState");function be(u){e.bindFramebuffer(e.DRAW_FRAMEBUFFER,u.framebuffer),e.viewport(u.viewport[0],u.viewport[1],u.viewport[2],u.viewport[3]),e.useProgram(u.program),e.bindVertexArray(u.vao),(u.blend?e.enable:e.disable).call(e,e.BLEND),(u.depth?e.enable:e.disable).call(e,e.DEPTH_TEST),(u.scissor?e.enable:e.disable).call(e,e.SCISSOR_TEST),e.scissor(u.scissorBox[0],u.scissorBox[1],u.scissorBox[2],u.scissorBox[3]),(u.cull?e.enable:e.disable).call(e,e.CULL_FACE),e.activeTexture(u.activeTexture)}a(be,"restoreState");function ze(u){let p=g.get(u);if(p)return p;let b=ca[u],E=e.createShader(e.VERTEX_SHADER);e.shaderSource(E,b.vs),e.compileShader(E);let O=e.createShader(e.FRAGMENT_SHADER);e.shaderSource(O,b.fs),e.compileShader(O);let N=e.createProgram();return e.attachShader(N,E),e.attachShader(N,O),e.bindAttribLocation(N,0,u==="draw:motes"?"a_seed":"a_corner"),e.linkProgram(N),p={key:u,program:N,vs:E,fs:O,ready:!1,failed:!1,uniforms:new Map,startedAt:i(),readyAt:0},g.set(u,p),p}a(ze,"startProgram");function He(u){if(u.ready||u.failed)return!0;if(s&&!e.getProgramParameter(u.program,s.COMPLETION_STATUS_KHR))return!1;if(!e.getProgramParameter(u.program,e.LINK_STATUS))return u.failed=!0,console.error(`[backdrop-looks] ${u.key} failed to link:`,e.getProgramInfoLog(u.program),e.getShaderInfoLog(u.vs),e.getShaderInfoLog(u.fs)),!0;let p=e.getProgramParameter(u.program,e.ACTIVE_UNIFORMS);for(let b=0;b<p;b++){let E=e.getActiveUniform(u.program,b),O=E.name.replace(/\[0\]$/,"");u.uniforms.set(O,e.getUniformLocation(u.program,E.name))}return u.ready=!0,u.readyAt=i(),!0}a(He,"pollProgram");function*Ne(u){let p=u.map(ze);for(;!p.every(He);)yield gr;return p}a(Ne,"awaitPrograms");function Ie(u,p){let b=e.createTexture();return e.activeTexture(e.TEXTURE0+p),e.bindTexture(u,b),b}a(Ie,"createTexture");function Ke(u){let p=_.get(u);return p||(p={family:u,cube:null,cubeSize:0,candidateCube:null,tile:null,ready:!1,job:null,framebuffer:null,stats:null},_.set(u,p)),p}a(Ke,"familyState");function*qe(u,p,b){let E=p;for(b.stage="band-wait";;){let O=Ir(e,u),N=i();if(O)return e.deleteSync(u),b.stage="bands",E-p+(N-E)/2;E=N,yield gr}}a(qe,"awaitFence");function*_e(u,p,b,E,O,N,H,ce){for(let T=0;T<O;T+=N){if(H.cancelled)return!1;let de=Math.min(N,O-T),pe=i(),re=le();e.bindFramebuffer(e.DRAW_FRAMEBUFFER,u.framebuffer),b>=0?e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_CUBE_MAP_POSITIVE_X+b,E,0):e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,E,0),e.viewport(0,0,O,O),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE),e.enable(e.SCISSOR_TEST),e.scissor(0,T,O,de),e.useProgram(p.program),e.uniform1i(p.uniforms.get("u_face"),b),e.uniform1f(p.uniforms.get("u_size"),O),e.bindVertexArray($),e.drawArrays(e.TRIANGLES,0,3),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,null,0),b<0&&T+de>=O&&(e.activeTexture(e.TEXTURE0+To),e.bindTexture(e.TEXTURE_2D,E),e.generateMipmap(e.TEXTURE_2D));let nt=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0);e.flush(),be(re),ce.issueMs+=i()-pe;let Fe=yield*qe(nt,pe,H);ce.gpuMs+=Fe,ce.maxBandMs=Math.max(ce.maxBandMs,Fe),ce.texels+=O*de,ce.bands+=1}return!0}a(_e,"bakeTarget");function M(u,p){let b=p===null?fa:Math.min(fa,ys/p);return Math.max(1,Math.min(u,Math.floor(b/u)))}a(M,"rowsPerBandFor");function j(u){let p=Ie(e.TEXTURE_CUBE_MAP,yr);return e.texStorage2D(e.TEXTURE_CUBE_MAP,1,e.RGBA8,u,u),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),p}a(j,"createCube");function*Y(u,p){let b=ua[u],E=Ke(u),O={family:u,startedAt:p.startedAt,programsReadyMs:0,levels:[],cubeSize:0,texelRateMs:null,readyMs:0,wallMs:0,cpuMs:0,bytes:0};E.stats=O;let N=[b.draw];b.bake&&N.push(b.bake),b.motes&&N.push("draw:motes"),p.stage="compile";let H=yield*Ne(N);if(p.stage="allocate",O.programsReadyMs=i()-p.startedAt,!H.some(ce=>ce.failed)){if(b.motes&&ye(),b.bake){let ce=g.get(b.bake),T=Math.round(yt*yt*4*4/3),de=a(ie=>({size:ie,bands:0,gpuMs:0,maxBandMs:0,issueMs:0,texels:0,wallMs:0}),"newLevel"),pe=null;E.framebuffer??=e.createFramebuffer();let re=xs,nt=le(),Fe=j(re);be(nt),yield,p.stage="bands";let Le=de(re),Pe=i();for(let ie=0;ie<6;ie++)if(!(yield*_e(E,ce,ie,Fe,re,M(re,pe),p,Le))){We(e,Fe);return}Le.wallMs=i()-Pe,O.levels.push(Le),pe=Le.gpuMs/Le.texels,O.texelRateMs=pe,E.cube=Fe,E.cubeSize=re,O.cubeSize=re,O.bytes=re*re*6*4+T,A+=O.bytes;let at=le();E.tile=Ie(e.TEXTURE_2D,To),e.texStorage2D(e.TEXTURE_2D,Math.log2(yt)+1,e.RGBA8,yt,yt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.REPEAT),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.REPEAT),be(at),yield;let Qe=de(yt),ot=i();if(!(yield*_e(E,ce,-1,E.tile,yt,M(yt,pe),p,Qe)))return;for(Qe.wallMs=i()-ot,O.tile=Qe,O.readyMs=i()-p.startedAt,E.ready=!0,l+=1,o(),Z();re<bs;){let ie=re*2;if(pe*ie*ie*6>gs)break;let Kt=le();Fe=j(ie),be(Kt),E.candidateCube=Fe,yield,Le=de(ie);let Nt=i(),it=!0;for(let Tt=0;Tt<6&&it;Tt++)it=yield*_e(E,ce,Tt,Fe,ie,M(ie,pe),p,Le);if(!it){We(e,Fe),E.candidateCube=null;return}Le.wallMs=i()-Nt,O.levels.push(Le),pe=Le.gpuMs/Le.texels,O.texelRateMs=pe,We(e,E.cube),E.cube=Fe,E.candidateCube=null,A+=ie*ie*6*4-re*re*6*4,O.bytes+=ie*ie*6*4-re*re*6*4,re=ie,E.cubeSize=re,O.cubeSize=re,l+=1,o()}O.wallMs=i()-p.startedAt,O.cpuMs=p.cpuMs,E.job=null;return}O.wallMs=i()-p.startedAt,O.cpuMs=p.cpuMs,E.ready=!0,E.job=null,l+=1,o(),Z()}}a(Y,"bakeFamily");function ee(u){let p=Ke(u);return p.ready||p.job!==null||(p.job=B(`bake ${u}`,b=>Y(u,b),!0)),p}a(ee,"ensureFamily");function te(u){for(let[p,b]of _)p!==u&&(I(b.job),b.job=null,(b.cube||b.tile)&&(A-=b.stats?.bytes??0),b.cube&&We(e,b.cube),b.candidateCube&&We(e,b.candidateCube),b.tile&&We(e,b.tile),b.framebuffer&&e.deleteFramebuffer(b.framebuffer),b.cube=null,b.cubeSize=0,b.candidateCube=null,b.tile=null,b.framebuffer=null,b.ready=!1)}a(te,"evictFamiliesExcept");let W=new Set;function Z(){for(let u of[...W])u.check()&&(W.delete(u),u.resolve())}a(Z,"notifyReady");function ue(u){let p=k.get(u);return p||(p={generation:-1,tints:null,tintLook:null,tintJob:null,shadowKey:null,checkedKey:null,shadowJob:null,shadowTexture:null,shadowSpare:null,shadowPacked:null,shadowWindow:[0,0,1],shadowStats:null},k.set(u,p)),p}a(ue,"paneState");function ge(u){return u.defaultTints.map(p=>Xo(p,.85))}a(ge,"lookTintsLinear");function*Re(u,p,b,E){let O=ue(u),N=ge(b);if(p!==null&&p.colors instanceof Uint8Array&&p.colors.length>0){let H=un(p.colors,p.visibility,3,65536);if(yield,E.cancelled)return;if(H.colors.length>0){let ce=b.tone==="dark"?.8:.6;N=[0,1,2].map(T=>Xo(H.colors[Math.min(T,H.colors.length-1)],ce))}}O.tints=N,O.tintLook=b.id,O.tintJob=null,Z(),l+=1,o()}a(Re,"computeTints");function ae(u,p){return u.tints===null||u.tintLook!==p.id?null:u.tints}a(ae,"currentTints");function*fe(u,p,b,E,O,N){let H=ue(u),ce=i(),T=jt;N.stage="shadow-allocate";let de=new Float32Array(T*T),pe=new Float32Array(T*T),re=new Float32Array(T*T),nt=new Float32Array(T*T),{positions:Fe,dimension:Le,visibility:Pe}=p,at=Math.floor(Fe.length/Le),Qe,ot,G,ie,Mt,Kt=0,Nt=E?Math.max(b.extentZ*2+Gt,Gt):Math.max(b.extentY*2+.12,.12);if(E){let K=[-.45,.55,.7];ie=-K[0]/K[2],Mt=-K[1]/K[2],Kt=b.stageZ-b.extentZ-Gt,Qe=b.stageX,ot=b.centerY,G=Math.max(b.extentX,b.extentY)*1.3+Nt*.8+.3}else{ie=-Ct[0]/Ct[1],Mt=-Ct[2]/Ct[1],Qe=b.stageX,ot=b.stageZ;let K=Nt*Math.hypot(ie,Mt);G=Math.max(b.extentX,b.extentZ)*1.25+K*.6+.35}let it=T/(2*G),Tt=Qe-G,_r=ot-G,Vt=Math.max(1,Math.floor(at/2e6)),Ar=4e4,Mr=0;N.stage="shadow-splat";for(let K=0;K<at;K+=Ar*Vt){let Ve=Math.min(at,K+Ar*Vt);for(let je=K;je<Ve;je+=Vt){let lt=Pe===null||Pe[je]!==0?1:0;if(lt<=0)continue;let St=je*Le,Ge=Fe[St],Dt=Le>1?Fe[St+1]:0,Sr=Le>2?Fe[St+2]:0,kr,Rr,Bt,Jt,Qt;E?(Bt=Sr-Kt,Jt=Ge,Qt=Dt):(Bt=Dt-b.floorY,Jt=Ge,Qt=Sr),kr=Jt+ie*Bt,Rr=Qt+Mt*Bt,Mr+=lt;let Co=Math.min(1,Math.max(0,Bt/Nt)),eo=(kr-Tt)*it-.5,to=(Rr-_r)*it-.5,ft=Math.floor(eo),ut=Math.floor(to);if(ft>=0&&ut>=0&&ft<T-1&&ut<T-1){let oo=eo-ft,ro=to-ut,dt=ut*T+ft,no=lt*(1-Co),ao=lt*Co,Cr=(1-oo)*(1-ro),$r=oo*(1-ro),Or=(1-oo)*ro,Fr=oo*ro;de[dt]+=no*Cr,de[dt+1]+=no*$r,de[dt+T]+=no*Or,de[dt+T+1]+=no*Fr,pe[dt]+=ao*Cr,pe[dt+1]+=ao*$r,pe[dt+T]+=ao*Or,pe[dt+T+1]+=ao*Fr}eo=(Jt-Tt)*it,to=(Qt-_r)*it,ft=eo|0,ut=to|0,ft>=0&&ut>=0&&ft<T&&ut<T&&(re[ut*T+ft]+=lt*Math.exp(-Co*2.2))}if(yield,N.cancelled)return}let Ro=it,ga=Math.max(1,Math.round(Ro*.035)),wa=Math.max(2,Math.round(Ro*.11)),va=Math.max(3,Math.round(Ro*.16));if(N.stage="shadow-blur",yield*vr(de,T,ga,3,nt),N.cancelled||(yield*vr(pe,T,wa,3,nt),N.cancelled)||(yield*vr(re,T,va,3,nt),N.cancelled))return;let Tr=a(K=>{let Ve=0;for(let Ge=0;Ge<K.length;Ge++)K[Ge]>Ve&&(Ve=K[Ge]);if(!(Ve>0))return 1;let je=new Uint32Array(1024),lt=0;for(let Ge=0;Ge<K.length;Ge++){let Dt=K[Ge];Dt>0&&(je[Math.min(1023,Math.floor(Dt/Ve*1024))]+=1,lt+=1)}let St=lt*.97;for(let Ge=0;Ge<1024;Ge++)if(St-=je[Ge],St<=0)return(Ge+1)/1024*Ve;return Ve},"percentile");for(let K=0;K<de.length;K++)de[K]+=pe[K]*.8;N.stage="shadow-normalise";let Ea=Tr(de);yield;let _a=Tr(re);yield;let Zt=new Uint16Array(T*T*2),qt=64;N.stage="shadow-pack";for(let K=0;K<T;K+=qt){let Ve=Math.min(T,K+qt)*T;for(let je=K*T;je<Ve;je++)Zt[je*2]=So(1-Math.exp(-1.4*de[je]/Ea)),Zt[je*2+1]=So(1-Math.exp(-1.2*re[je]/_a));if(yield,N.cancelled)return}if(N.cancelled)return;N.stage="shadow-upload";let It=H.shadowSpare;if(It===null){let K=le();It=Ie(e.TEXTURE_2D,zt),e.texStorage2D(e.TEXTURE_2D,1,e.RG16F,T,T),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),be(K),A+=T*T*4,H.shadowSpare=It,yield}for(let K=0;K<T;K+=qt){if(N.cancelled)return;let Ve=Math.min(qt,T-K),je=le();e.activeTexture(e.TEXTURE0+zt),e.bindTexture(e.TEXTURE_2D,It),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texSubImage2D(e.TEXTURE_2D,0,0,K,T,Ve,e.RG,e.HALF_FLOAT,Zt.subarray(K*T*2,(K+Ve)*T*2)),be(je),yield}N.cancelled||(H.shadowSpare=H.shadowTexture,H.shadowTexture=It,H.shadowWindow=[Qe,ot,G],H.shadowPacked=Zt,H.shadowKey=O,Z(),H.shadowJob=null,H.shadowStats={points:at,visible:Math.round(Mr),stride:Vt,wallMs:i()-ce,cpuMs:N.cpuMs},l+=1,o())}a(fe,"bakeShadow");function Ce(u,p,b,E){let O=ue(u),N=n(u),H=N===null?0:N.generation;if((H!==O.generation||O.tintLook!==p.id)&&O.tintJob===null&&(O.generation=H,O.tintJob=B(`tints ${u}`,ce=>Re(u,N,p,ce))),p.family==="atelier"&&p.program==="atelier"&&N!==null&&N.positions.length>0){O.positionsRef!==N.positions&&(O.positionsRef=N.positions,O.positionsEpoch=(O.positionsEpoch??0)+1);let ce=[O.positionsEpoch,N.positions.length,N.dimension,E?1:0,b.floorY.toFixed(5),b.stageX.toFixed(5),b.stageZ.toFixed(5)].join("|"),T=`${ce}|${H}`;if(T!==O.checkedKey){O.checkedKey=T,I(O.shadowJob);let de={...b};O.shadowJob=B(`shadow ${u}`,function*(pe){pe.stage="shadow-signature";let re=`${ce}|${ws(N.visibility)}`;if(yield,!pe.cancelled){if(re===O.shadowKey){O.shadowJob=null;return}yield*fe(u,N,de,E,re,pe)}})}}return O}a(Ce,"syncPane");function $e(){return m&&f!==null&&!r()&&(typeof document>"u"||document.visibilityState!=="hidden")&&(f==="nebula"||f==="aurora-dark"||f.startsWith("abyss"))}a($e,"ambientWanted");function he(){if(w=null,!$e())return;let u=i();y+=Math.min(.1,(u-x)/1e3),x=u,l+=1,S=!0,t(),w=setTimeout(he,1e3/30)}a(he,"tickAmbient");function me(){$e()?w===null&&(x=i(),w=setTimeout(he,1e3/30)):w!==null&&(clearTimeout(w),w=null)}a(me,"syncAmbient");let Ae=a(()=>me(),"onVisibility");typeof document<"u"&&document.addEventListener("visibilitychange",Ae);let Ue=typeof matchMedia=="function"?matchMedia("(prefers-reduced-motion: reduce)"):null,Oe=a(()=>{me(),r()&&d<1&&Te()&&(d=1,l+=1,o())},"onReducedMotion");Ue?.addEventListener?.("change",Oe);function De(u){let p=u===null?null:u;if(p!==null&&!Rt(p))throw new TypeError(`Unknown backdrop look "${u}".`);if(p===f)return;let b=f===null?null:st[f].program;if(f=p,l+=1,p!==null){let E=st[p].program;te(E),d=ee(E).ready&&b===E?1:0}else te(null),d=0;me()}a(De,"setLook");function Te(){if(f===null)return!1;let u=_.get(st[f].program);return u!==void 0&&u.ready}a(Te,"isLookReady");function Je(u){S=!1,f!==null&&Te()&&d<1&&(d=r()?1:Math.min(1,d+u/.35),l+=1)}a(Je,"advance");function At(){return f===null?null:Te()&&d<1?"backdrop-fade":null}a(At,"frameCause");function we(){return S&&w!==null?"backdrop-motion":null}a(we,"motionCause");function oe(u,p,b){let E=u.uniforms.get(p);E!==void 0&&e.uniform3f(E,b[0],b[1],b[2])}a(oe,"setUniform3");function se(u,p,b){let E=u.uniforms.get(p);E!==void 0&&e.uniform1f(E,b)}a(se,"setUniform1");function q(u,p,b){let E=u.uniforms.get(p);E!==void 0&&e.uniform4f(E,b[0],b[1],b[2],b[3])}a(q,"setUniform4");let J=null,Q=null;function ve(u){return u===null?{texture:null,window:[0,0,1],ready:!1}:(Q!==u.packed&&(J===null?(J=Ie(e.TEXTURE_2D,zt),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE)):(e.activeTexture(e.TEXTURE0+zt),e.bindTexture(e.TEXTURE_2D,J)),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texImage2D(e.TEXTURE_2D,0,e.RG16F,u.size,u.size,0,e.RG,e.HALF_FLOAT,u.packed),Q=u.packed),{texture:J,window:u.window,ready:!0})}a(ve,"frozenShadow");let Se=[[0,0,0],[0,0,0],[0,0,0]];function rt(u){if(c||f===null)return!1;let p=st[f],b=p.program,E=_.get(b),O=ua[b],N=u.frozen??null,H=N===null?Ce(u.viewId,p,u.geometry,u.planar===1):null,ce=N===null?d:1;if(!E||!E.ready||ce<=0)return!1;let T=g.get(O.draw);if(!T||!T.ready)return!1;let de=u.ndcTransform??ps,pe=N===null?y:N.time,re=N!==null?N.tints:ae(H,p)??ge(p);for(let G=0;G<3;G++)Se[G][0]=re[G][0],Se[G][1]=re[G][1],Se[G][2]=re[G][2];let nt=V.isEnabled(e.BLEND),Fe=V.isEnabled(e.DEPTH_TEST),Le=V.activeTexture,Pe=u.geometry;e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.depthMask(!1),e.useProgram(T.program),e.uniformMatrix4fv(T.uniforms.get("u_invMvp"),!1,u.invMvp),e.uniform3f(T.uniforms.get("u_eye"),u.eye[0],u.eye[1],u.eye[2]),se(T,"u_pixelRatio",u.pixelRatio);let at=T.uniforms.get("u_viewport");at!==void 0&&e.uniform2f(at,u.viewportWidth,u.viewportHeight),se(T,"u_glowCenterX",u.glowCenterX),se(T,"u_opacity",ce),q(T,"u_ndcTransform",de);let Qe=p.surface;if(oe(T,"u_surface",[Qe[0]/255,Qe[1]/255,Qe[2]/255]),se(T,"u_planar",u.planar),oe(T,"u_stageCenter",[Pe.stageX,Pe.centerY,Pe.stageZ]),oe(T,"u_stageExtent",[Pe.extentX,Pe.extentY,Pe.extentZ]),se(T,"u_floorY",Pe.floorY),se(T,"u_time",pe),se(T,"u_ambient",N===null?w!==null?1:0:N.ambient),se(T,"u_dark",p.tone==="dark"?1:0),oe(T,"u_tint0",Se[0]),oe(T,"u_tint1",Se[1]),oe(T,"u_tint2",Se[2]),E.cube){e.activeTexture(e.TEXTURE0+yr),e.bindTexture(e.TEXTURE_CUBE_MAP,E.cube);let G=T.uniforms.get("u_sky");G!==void 0&&e.uniform1i(G,yr)}if(E.tile){e.activeTexture(e.TEXTURE0+To),e.bindTexture(e.TEXTURE_2D,E.tile);let G=T.uniforms.get("u_tile");G!==void 0&&e.uniform1i(G,To)}if(b==="atelier"){let G=N===null?{texture:H.shadowTexture,window:H.shadowWindow,ready:H.shadowTexture!==null&&H.shadowKey!==null}:ve(N.shadow);e.activeTexture(e.TEXTURE0+zt),e.bindTexture(e.TEXTURE_2D,G.texture);let ie=T.uniforms.get("u_shadow");ie!==void 0&&e.uniform1i(ie,zt),oe(T,"u_shadowWindow",G.window),se(T,"u_shadowReady",G.ready?1:0),oe(T,"u_keyLight",Ct),se(T,"u_paperGap",Gt)}e.bindVertexArray($),e.drawArrays(e.TRIANGLES,0,3);let ot=null;if(O.motes&&X!==null){let G=g.get("draw:motes");if(G&&G.ready){let ie=V.blendFunc;ot=[ie.srcRgb,ie.dstRgb,ie.srcAlpha,ie.dstAlpha],e.useProgram(G.program),e.enable(e.BLEND),p.tone==="dark"?e.blendFuncSeparate(e.ONE,e.ONE,e.ZERO,e.ONE):e.blendFuncSeparate(e.ONE,e.ONE_MINUS_SRC_ALPHA,e.ZERO,e.ONE),e.uniformMatrix4fv(G.uniforms.get("u_mvp"),!1,u.mvp),oe(G,"u_eye",u.eye),oe(G,"u_stageCenter",[Pe.stageX,Pe.centerY,Pe.stageZ]),oe(G,"u_stageExtent",[Pe.extentX,Pe.extentY,Pe.extentZ]),se(G,"u_projScale",u.projection[5]),se(G,"u_viewportHeight",u.viewportHeight),se(G,"u_pixelRatio",u.pixelRatio),se(G,"u_time",pe),q(G,"u_ndcTransform",de),se(G,"u_planar",u.planar),se(G,"u_dark",p.tone==="dark"?1:0),se(G,"u_opacity",ce),se(G,"u_maxPointSize",h),oe(G,"u_tint0",Se[0]),oe(G,"u_tint1",Se[1]),e.bindVertexArray(X),e.drawArrays(e.POINTS,0,wr)}}return e.bindVertexArray(null),e.depthMask(!0),(nt?e.enable:e.disable).call(e,e.BLEND),ot!==null&&e.blendFuncSeparate(...ot),(Fe?e.enable:e.disable).call(e,e.DEPTH_TEST),e.activeTexture(Le),!0}a(rt,"draw");function ma(u){let p=k.get(u);if(p){I(p.tintJob),I(p.shadowJob);for(let b of[p.shadowTexture,p.shadowSpare])b!==null&&(We(e,b),A-=jt*jt*4);k.delete(u),ko.delete(u)}}a(ma,"forgetView");function Er(u){if(!c){c=!0,P(),v.length=0,w!==null&&clearTimeout(w),w=null,typeof document<"u"&&document.removeEventListener("visibilitychange",Ae),Ue?.removeEventListener?.("change",Oe);for(let p of W)p.reject(new Error("Backdrop look renderer disposed."));if(W.clear(),!!u){for(let p of g.values())Nr(e,p.program),e.deleteShader(p.vs),e.deleteShader(p.fs);for(let p of _.values())p.cube&&We(e,p.cube),p.candidateCube&&We(e,p.candidateCube),p.tile&&We(e,p.tile),p.framebuffer&&e.deleteFramebuffer(p.framebuffer);for(let p of k.values())p.shadowTexture&&We(e,p.shadowTexture),p.shadowSpare&&We(e,p.shadowSpare);J&&We(e,J),e.deleteVertexArray($),e.deleteBuffer(U),X&&e.deleteVertexArray(X),ne&&e.deleteBuffer(ne)}}}a(Er,"teardown");function ba(){let u={};for(let[b,E]of _)u[b]={ready:E.ready,...E.stats??{}};let p={};for(let[b,E]of k)p[b]=E.shadowStats;return{activeId:f,opacity:d,version:l,textureBytes:A,jobsQueued:v.length,jobHistory:z.slice(),slices:{...R},families:u,shadows:p,ambient:w!==null,parallelCompile:s!==null,programs:[...g.values()].map(b=>({key:b.key,ready:b.ready,failed:b.failed,compileMs:b.readyAt?b.readyAt-b.startedAt:null}))}}a(ba,"getDiagnostics");function xa(u){if(f===null)return null;let p=st[f],b=k.get(u)??null,E=(b&&ae(b,p))??null,O=p.program==="atelier"?b?.shadowPacked??null:null,N=w!==null?1:0,H=ko.get(u);if(H!==void 0&&H.id===f&&H.tintsRef===E&&H.packed===O&&H.state.time===y&&H.state.ambient===N)return H.state;let ce=E??ge(p),T=Object.freeze({id:f,tints:Object.freeze(ce.map(de=>Object.freeze([de[0],de[1],de[2]]))),time:y,ambient:N,shadow:O===null?null:Object.freeze({packed:O,window:Object.freeze([...b.shadowWindow]),size:jt})});return ko.set(u,{id:f,tintsRef:E,packed:O,state:T}),T}a(xa,"getExportState");let ko=new Map;function ya(){let u=a(()=>Te(),"check");return u()?Promise.resolve():new Promise((p,b)=>W.add({check:u,resolve:p,reject:b}))}return a(ya,"whenReady"),{setLook:De,advance:Je,getExportState:xa,whenReady:ya,frameCause:At,motionCause:we,draw:rt,forgetView:ma,dispose:a(()=>Er(!0),"dispose"),abandon:a(()=>Er(!1),"abandon"),isActive:a(()=>f!==null,"isActive"),getVersion:a(()=>l,"getVersion"),setAmbientMotion(u){m=u===!0,me()},getDiagnostics:ba}}a(ha,"createBackdropLookRenderer");var Yt=null;function vs(){if(Yt!==null&&!Yt.gl.isContextLost())return Yt;if(typeof document>"u")throw new Error("Figure export needs a document to draw the background look.");let e=document.createElement("canvas");e.width=1,e.height=1;let o=e.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,preserveDrawingBuffer:!0});if(!o)throw new Error("Figure export needs WebGL2 to draw the background look.");let t=ha(o,{invalidate:a(()=>{},"invalidate"),prefersReducedMotion:a(()=>!0,"prefersReducedMotion"),readViewSource:a(()=>null,"readViewSource")});return Yt={canvas:e,gl:o,renderer:t},Yt}a(vs,"getSharedContext");function Es(e){let o=new Float32Array(16),t=e[0],r=e[1],n=e[2],i=e[3],s=e[4],h=e[5],c=e[6],f=e[7],d=e[8],l=e[9],m=e[10],w=e[11],y=e[12],x=e[13],S=e[14],A=e[15],g=t*h-r*s,_=t*c-n*s,k=t*f-i*s,v=r*c-n*h,z=r*f-i*h,F=n*f-i*c,L=d*x-l*y,R=d*S-m*y,C=d*A-w*y,P=l*S-m*x,D=l*A-w*x,B=m*A-w*S,I=g*B-_*D+k*P+v*C-z*R+F*L;if(!Number.isFinite(I)||Math.abs(I)<1e-30)return null;let $=1/I;return o[0]=(h*B-c*D+f*P)*$,o[1]=(n*D-r*B-i*P)*$,o[2]=(x*F-S*z+A*v)*$,o[3]=(m*z-l*F-w*v)*$,o[4]=(c*C-s*B-f*R)*$,o[5]=(t*B-n*C+i*R)*$,o[6]=(S*k-y*F-A*_)*$,o[7]=(d*F-m*k+w*_)*$,o[8]=(s*D-h*C+f*L)*$,o[9]=(r*C-t*D-i*L)*$,o[10]=(y*z-x*k+A*g)*$,o[11]=(l*k-d*z-w*g)*$,o[12]=(h*R-s*P-c*L)*$,o[13]=(t*P-r*R+n*L)*$,o[14]=(x*_-y*v-S*g)*$,o[15]=(d*v-l*_+m*g)*$,o}a(Es,"invert4");async function pa({renderState:e,width:o,height:t,ndcTransform:r,pixelScale:n,signal:i=null}){let s=e?.backdrop?.look??null;if(s===null||!Rt(s.id))throw new TypeError("Figure export render state names no background look.");if(!(Number.isInteger(o)&&o>0&&Number.isInteger(t)&&t>0))throw new TypeError("Figure export background-look raster needs a positive integer size.");let{canvas:h,gl:c,renderer:f}=vs();f.setLook(s.id),await f.whenReady(),Ur(i);let d=Math.min(c.getParameter(c.MAX_RENDERBUFFER_SIZE),...c.getParameter(c.MAX_VIEWPORT_DIMS)),l=Math.min(1,d/o,d/t),m=Math.max(1,Math.floor(o*l)),w=Math.max(1,Math.floor(t*l));h.width=m,h.height=w,c.viewport(0,0,m,w);let y=Float32Array.from(e.mvpMatrix),x=Es(y);if(x===null)throw new Error("Figure export cannot draw the background look: the camera is singular.");let S=e.backdrop,A=n*l;if(!f.draw({viewId:"figure-export",invMvp:x,mvp:y,projection:Float32Array.from(e.projectionMatrix),eye:Float32Array.from(e.cameraPosition),pixelRatio:S.pixelRatio*A,glowCenterX:S.glowCenterX,viewportWidth:e.viewportWidth*A,viewportHeight:e.viewportHeight*A,planar:S.planarity>=.5?1:0,geometry:S,ndcTransform:r,frozen:s}))throw new Error(`Figure export could not draw the "${s.id}" background look.`);let _=document.createElement("canvas");_.width=o,_.height=t;let k=_.getContext("2d");return k.imageSmoothingEnabled=!0,k.imageSmoothingQuality="high",k.drawImage(h,0,0,o,t),_}a(pa,"renderBackdropLookRaster");function xf(e,o,t){return e?.kind==="look"&&o?.viewerPaper===!0&&t?.backdrop?.look!=null}a(xf,"figureDrawsBackdropLook");function _s({renderState:e,plotRect:o,crop:t=null}){let r=Lt({renderState:e,plotRect:o,crop:t}),n=r.viewportToPlot(r.srcX0,r.srcY0),i=r.viewportW,s=r.viewportH,h=a(l=>(l-n.x)/r.scale+r.srcX0,"toViewportX"),c=a(l=>(l-n.y)/r.scale+r.srcY0,"toViewportY"),f=o.x+o.width/2,d=o.y+o.height/2;return{ndcTransform:[o.width/r.scale/i,o.height/r.scale/s,2*h(f)/i-1,1-2*c(d)/s],viewportPerPlot:1/r.scale}}a(_s,"resolveBackdropLookPlacement");async function As({renderState:e,plotRect:o,crop:t=null,width:r,height:n,signal:i=null}){let{ndcTransform:s,viewportPerPlot:h}=_s({renderState:e,plotRect:o,crop:t}),c=r/o.width/h;return pa({renderState:e,width:r,height:n,ndcTransform:s,pixelScale:c,signal:i})}a(As,"renderBackdropLookForPlot");function yf(e,o){return`<image class="cellucid-backdrop-look" x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" href="${e}" preserveAspectRatio="none"/>`}a(yf,"renderSvgBackdropLookImage");var tt={key:null,canvas:null,pending:null};function gf({renderState:e,plotRect:o,crop:t,width:r,height:n},i){let s=e.backdrop.look,h=JSON.stringify([s.id,s.tints,s.time,s.shadow?.window??null,Array.from(e.mvpMatrix),e.viewportWidth,e.viewportHeight,o,t,r,n]);return tt.key===h&&tt.canvas!==null?tt.canvas:(tt.pending!==h&&(tt.pending=h,As({renderState:e,plotRect:o,crop:t,width:r,height:n}).then(c=>{tt.pending===h&&(tt.key=h,tt.canvas=c,tt.pending=null,i())}).catch(c=>{tt.pending===h&&(tt.pending=null),console.warn("[FigureExport] Background-look preview failed:",c)})),null)}a(gf,"peekBackdropLookPreview");export{Ql as a,br as b,Xe as c,Do as d,pt as e,Be as f,Cs as g,Bo as h,Ut as i,$s as j,tn as k,Os as l,on as m,rn as n,Rt as o,fn as p,ha as q,Ms as r,Sa as s,gt as t,co as u,Ts as v,Ss as w,nn as x,Oa as y,cn as z,ho as A,kn as B,yo as C,Qo as D,Nc as E,Ic as F,er as G,Rn as H,$n as I,vi as J,Xt as K,On as L,Ei as M,Dc as N,Bc as O,_i as P,Ai as Q,Uc as R,jc as S,Gc as T,Xc as U,Vc as V,Zc as W,qc as X,Jc as Y,Qc as Z,Hs as _,Ws as $,bn as aa,oi as ba,nc as ca,ac as da,ic as ea,ni as fa,sc as ga,cc as ha,ct as ia,$t as ja,pc as ka,Mc as la,Tc as ma,Sc as na,al as oa,il as pa,sl as qa,cl as ra,bl as sa,xl as ta,Al as ua,Ml as va,Ol as wa,Fl as xa,Yl as ya,Kl as za,Vl as Aa,Zl as Ba,xf as Ca,As as Da,yf as Ea,gf as Fa};
