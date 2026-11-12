import{b as ht,d as dt}from"./chunk.FE2T35QV.js";import{b as qe,e as Se}from"./chunk.5EODKS5P.js";import{a as Oe}from"./chunk.WIQLOHHT.js";import{a as ft,b as R}from"./chunk.XYMIX5KS.js";import{a}from"./chunk.BLB2Q6XA.js";var Ee=Object.freeze(["full","sculpted","light","ultralight"]),Ar="full",Tr=Object.freeze({full:Object.freeze({fog:!0,fogAlpha:!0,sphere:!0}),sculpted:Object.freeze({fog:!0,fogAlpha:!1,sphere:!0}),light:Object.freeze({fog:!1,fogAlpha:!1,sphere:!1}),ultralight:Object.freeze({fog:!1,fogAlpha:!1,sphere:!1})}),kt=`${Ee.slice(0,-1).map(e=>`"${e}"`).join(", ")}, or "${Ee.at(-1)}"`;function Lr(e){return Ee.includes(e)}a(Lr,"isShaderQuality");function pt(){return kt}a(pt,"describeShaderQualities");var Xe=new Set([1,2,3]),wt=new Set(Ee),gt=Object.freeze(["pointSize","sizeAttenuation","viewportHeight","viewportWidth","fov","lightingStrength","fogDensity","cameraDistance","pointSizeMax"]),mt=Object.freeze([Object.freeze(["mvpMatrix",16]),Object.freeze(["viewMatrix",16]),Object.freeze(["modelMatrix",16]),Object.freeze(["projectionMatrix",16]),Object.freeze(["fogColor",3]),Object.freeze(["lightDir",3]),Object.freeze(["cameraPosition",3])]);function yt(e,t="Renderer dimensionLevel"){if(!Number.isInteger(e)||!Xe.has(e))throw new RangeError(`${t} is required and must be exactly 1, 2, or 3; received ${String(e)}.`);return e}a(yt,"requireDimensionLevel");function Yt(e,t="Renderer viewId"){if(typeof e!="string"||e.length===0)throw new TypeError(`${t} must be a non-empty string.`);return e}a(Yt,"requireViewId");function Wt(e,t="Renderer quality"){if(!wt.has(e))throw new RangeError(`${t} must be exactly ${pt()}; received ${String(e)}.`);return e}a(Wt,"requireShaderQuality");function Nr(e,t){if(!Number.isFinite(e))throw new TypeError(`${t} must be a finite number; received ${String(e)}.`);return e}a(Nr,"requireFiniteNumber");function qt(e,t,r){if(!Array.isArray(e)&&!ArrayBuffer.isView(e)||e.length!==t)throw new TypeError(`${r} must contain exactly ${t} numeric values.`);for(let o=0;o<t;o++)if(!Number.isFinite(e[o]))throw new TypeError(`${r}[${o}] must be a finite number; received ${String(e[o])}.`);return e}a(qt,"requireNumericVector");function ae(e){return e===null?"HighPerfRenderer render":`HighPerfRenderer snapshot "${e}"`}a(ae,"getRenderContractOwner");function Xt(e,t){if(!Array.isArray(e)&&!ArrayBuffer.isView(e)||e.length!==t)return!1;for(let r=0;r<t;r++)if(!Number.isFinite(e[r]))return!1;return!0}a(Xt,"hasExactFiniteVector");function Or(e,t=null){if(e===null||typeof e!="object"||Array.isArray(e))throw new TypeError(`${ae(t)} parameters must be an object.`);for(let r=0;r<mt.length;r++){let o=mt[r];Xt(e[o[0]],o[1])||qt(e[o[0]],o[1],`${ae(t)} ${o[0]}`)}for(let r=0;r<gt.length;r++){let o=gt[r],n=e[o];if(!Number.isFinite(n))throw new TypeError(`${ae(t)} ${o} must be a finite number; received ${String(n)}.`)}if(!Number.isInteger(e.forceLOD)||e.forceLOD<-1)throw new RangeError(`${ae(t)} forceLOD must be an integer greater than or equal to -1.`);if(typeof e.autoFog!="boolean")throw new TypeError(`${ae(t)} autoFog must be a boolean.`);if(typeof e.useAlphaTexture!="boolean")throw new TypeError(`${ae(t)} useAlphaTexture must be a boolean.`);if(e.multisampled!==void 0&&typeof e.multisampled!="boolean")throw new TypeError(`${ae(t)} multisampled must be a boolean when given.`);return wt.has(e.quality)||Wt(e.quality,`${ae(t)} quality`),(typeof e.viewId!="string"||e.viewId.length===0)&&Yt(e.viewId,`${ae(t)} viewId`),Xe.has(e.dimensionLevel)||yt(e.dimensionLevel,`${ae(t)} dimensionLevel`),e}a(Or,"requireRenderContract");function Fr(e,t,r,o,n,s){let l=yt(r,`${s} dimensionLevel`);if(!(t instanceof Float32Array)||t.length!==e*l)throw new TypeError(`${s} positions must be a Float32Array with exactly ${R(e*l,"value")} (${l} per point).`);if(!(o instanceof Uint8Array)||o.length!==e*4)throw new TypeError(`${s} colors must be an RGBA Uint8Array with exactly ${R(e*4,"byte")}.`);if(n!==null&&(!(n instanceof Uint8Array)||n.length!==e))throw new TypeError(`${s} alpha values must be null or a Uint8Array with exactly ${R(e,"entry","entries")}.`);return{alphas:n,colors:o,positions:t}}a(Fr,"requireSnapshotPointData");function Mr(e,t,r){if(!(t instanceof Uint8Array)||t.length!==e*4)throw new TypeError(`${r} colors must be an RGBA Uint8Array with exactly ${R(e*4,"byte")}.`);return t}a(Mr,"requireSnapshotColors");var _t=255;function Fe(e){return Number.isFinite(e)?R(e,"cell"):`${String(e)} (not a count of cells)`}a(Fe,"cellsOf");function Ae(e,{pointCount:t,dimensionLevel:r=null,requireIndices:o=!1,owner:n}){if(e===null)return null;if(e===void 0||typeof e!="object"||Array.isArray(e)||!Object.isFrozen(e))throw new TypeError(`${n} must be null or one frozen level-of-detail membership.`);let{admissionLevels:s,count:l,generationToken:i,indices:c,lodLevel:u}=e;if(!Number.isSafeInteger(e.pointCount)||e.pointCount!==t||!Xe.has(e.dimensionLevel)||r!==null&&e.dimensionLevel!==r)throw new RangeError(`${n} describes ${Fe(e.pointCount)} in ${String(e.dimensionLevel)}D, not the view's ${Fe(t)}${r===null?"":` in ${r}D`}.`);if(!Number.isInteger(u)||u<0||u>=_t||!Number.isSafeInteger(l)||l<0||l>t)throw new RangeError(`${n} must name a reduced level below ${_t} drawing at most ${Fe(t)}.`);if(i===null||typeof i!="object"||!Object.isFrozen(i))throw new TypeError(`${n} generationToken must be one frozen object.`);if(s!==null&&(!(s instanceof Uint8Array)||s.length!==t))throw new TypeError(`${n} admissionLevels must be null or one byte a cell.`);if(c!==null&&(!(c instanceof Uint32Array)||c.length!==l)||o&&c===null)throw new TypeError(`${n} indices must be ${o?"":"null or "}the level's ${Fe(l)} as a Uint32Array.`);return e}a(Ae,"requireLodMembership");function zr(e,t){if(e===null)return!0;let r=e.admissionLevels;return r===null?t<e.count:r[t]<=e.lodLevel}a(zr,"lodMembershipAdmits");function Dr(e,t,r){if(!(t instanceof Uint8Array)||t.length!==e)throw new TypeError(`${r} alpha values must be a Uint8Array with exactly ${R(e,"entry","entries")}.`);return t}a(Dr,"requireSnapshotAlphas");function Me(e,t){return e/Math.max(2*Math.tan(t*.5),1e-6)*.01}a(Me,"pointScaleFor");function Vt(e){let t=e.getParameter(e.ALIASED_POINT_SIZE_RANGE),r=Array.isArray(t)||ArrayBuffer.isView(t)?Number(t[1]):Number.NaN;return Number.isFinite(r)&&r>0?r:null}a(Vt,"gpuPointSizeMax");function Gr(e){let t=Vt(e);return t===null?160:Math.min(160,t)}a(Gr,"pointSpriteCap");function ze(e,{pointSize:t,pointScale:r,sizeAttenuation:o,pointSizeMax:n}){let s=t*r/Math.max(e,.001),l=t*(1-o)+s*o;return Math.min(Math.max(l,.5),n)}a(ze,"pointSpriteSize");var De=`
// Point sprite sizing, shared by every point shader (rendering/point-sprite.js).
uniform float u_pointSize;
// The largest sprite this pass draws, in the pixels it draws into: the
// viewer's cap (rendering/point-sprite.js, bounded by the GPU), times a
// figure export's raster scale.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth:
// viewportHeight / (2 tan(fov / 2)) * 0.01.
uniform float u_pointScale;

float pointSpriteSize(float eyeDepth) {
  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  return clamp(mix(u_pointSize, perspectiveSize, u_sizeAttenuation), ${.5.toFixed(1)}, u_pointSizeMax);
}
`;var Te=3,fe=254,H=253;function xt(e,t){if(e!=="layer"&&e!=="opacity")throw new TypeError(`${t} must say what its colors' alpha byte is: 'layer' or 'opacity', not ${String(e)}.`);return e}a(xt,"requireColorAlphaMeaning");var Zt=new Uint8Array(Uint32Array.of(1).buffer)[0]===1,Qt=Object.freeze({layered:!1,unread:0});function Ve(e){let t=!1,r=0;if(e.byteOffset%4===0){let o=new Uint32Array(e.buffer,e.byteOffset,e.length>>>2),n=Zt?24:0;for(let s=0;s<o.length;s++){let l=o[s]>>>n&255;l!==255&&(t=!0,l===H&&r++)}}else for(let o=3;o<e.length;o+=4)e[o]!==255&&(t=!0,e[o]===H&&r++);return t?Object.freeze({layered:t,unread:r}):Qt}a(Ve,"colorLayersOf");var $=Math.fround((Te-.5)/255);function kr(e,t,r){if(!(e instanceof Uint8Array)||e.length!==t)throw new TypeError(`${r} must be a Uint8Array with exactly ${R(t,"entry","entries")}.`);let o=Jt(e);if(o>=0)throw new RangeError(`${r} entry ${o} must be exactly 0 or 1.`);return e}a(kr,"requirePointTransparency");function Kt(e,t,r){for(let o=t;o<r;o++)if((e[o]&4278124286)!==0)return o;return-1}a(Kt,"firstNonBinaryWord");function Jt(e){let t=e.length,r=Math.min(t,4-(e.byteOffset&3)&3);for(let n=0;n<r;n++)if(e[n]>1)return n;let o=t-r>>>2;if(o>0){let n=new Uint32Array(e.buffer,e.byteOffset+r,o),s=Kt(n,0,o);if(s>=0){let l=r+s*4;for(;e[l]<=1;)l++;return l}}for(let n=r+o*4;n<t;n++)if(e[n]>1)return n;return-1}a(Jt,"firstNonBinaryByte");function qr(e){if(e.byteOffset%4!==0||e.length%4!==0)throw new TypeError("Neutral gray fill requires a word-aligned RGBA8 array.");let t=new Uint32Array(Uint8Array.of(211,211,211,255).buffer)[0];return new Uint32Array(e.buffer,e.byteOffset,e.length>>>2).fill(t),e}a(qr,"fillNeutralGray");var vt=3;function J(e,t,{positive:r=!1}={}){if(!Number.isFinite(e)||r&&e<=0)throw new RangeError(`${t} must be a ${r?"positive ":""}finite number.`);return e}a(J,"requireFinite");function er(e){if(e===null||typeof e!="object"||Array.isArray(e)||Object.getPrototypeOf(e)!==Object.prototype)throw new TypeError("Picking input must be one plain object.");let{dimension:t,lodMembership:r=null,positions:o,spatialIndex:n=null,transparency:s,mvpMatrix:l,cursor:i,pane:c,pointSize:u,sizeAttenuation:f,fov:p,pointSizeMax:m,pointLayers:d=null}=e;if(t!==1&&t!==2&&t!==3)throw new RangeError("Picking dimension must be exactly 1, 2, or 3.");if(!(o instanceof Float32Array)||o.length%t!==0)throw new TypeError("Picking positions must contain exactly dimension Float32 values per point.");let h=o.length/t;if(!(s instanceof Uint8Array)||s.length!==h)throw new TypeError("Picking transparency must be a Uint8Array matching the point count.");if(!Array.isArray(l)&&!ArrayBuffer.isView(l)||l.length!==16)throw new TypeError("Picking mvpMatrix must hold exactly 16 values.");for(let g=0;g<16;g++)J(l[g],`Picking mvpMatrix[${g}]`);if(i===null||typeof i!="object")throw new TypeError("Picking cursor must be an object.");if(J(i.x,"Picking cursor.x"),J(i.y,"Picking cursor.y"),c===null||typeof c!="object")throw new TypeError("Picking pane must be an object.");if(J(c.cssWidth,"Picking pane.cssWidth",{positive:!0}),J(c.cssHeight,"Picking pane.cssHeight",{positive:!0}),J(c.framebufferHeight,"Picking pane.framebufferHeight",{positive:!0}),J(u,"Picking pointSize",{positive:!0}),J(f,"Picking sizeAttenuation"),J(p,"Picking fov",{positive:!0}),J(m,"Picking pointSizeMax",{positive:!0}),d!==null){if(typeof d!="object"||!(d.colors instanceof Uint8Array)||d.colors.length!==h*4||typeof d.readEveryLevel!="boolean")throw new TypeError("Picking pointLayers must be null or {colors: RGBA8 of every point, readEveryLevel, readPointSize}.");J(d.readPointSize,"Picking pointLayers.readPointSize",{positive:!0})}if(n!==null&&(typeof n!="object"||n.pointCount!==h||n.positions!==o||n.dimensionLevel!==t||typeof n.visitProjectedRectCandidates!="function"))throw new TypeError("Picking spatialIndex must be null or an exact matching spatial owner.");return{dimension:t,lodMembership:Ae(r,{pointCount:h,dimensionLevel:t,owner:"Picking lodMembership"}),pointCount:h,positions:o,spatialIndex:n,transparency:s,mvpMatrix:l,cursor:i,pane:c,pointSize:u,sizeAttenuation:f,fov:p,pointSizeMax:m,pointLayers:d}}a(er,"requireScreenPickInput");function Ze({w:e,pointSize:t,sizeAttenuation:r,fov:o,framebufferHeight:n,devicePixelRatio:s,pointSizeMax:l}){return ze(e,{pointSize:t,pointScale:Me(n,o),sizeAttenuation:r,pointSizeMax:l})/2/s}a(Ze,"drawnPointRadiusCss");function Jr(e){let{dimension:t,lodMembership:r,pointCount:o,positions:n,spatialIndex:s,transparency:l,mvpMatrix:i,cursor:c,pane:u,pointSize:f,sizeAttenuation:p,fov:m,pointSizeMax:d,pointLayers:h}=er(e),g=r===null?null:r.admissionLevels,w=r===null?-1:r.lodLevel,y=r===null||g!==null?o:r.count,{cssWidth:_,cssHeight:x,framebufferHeight:A}=u,q=A/x,G={w:1,pointSize:f,sizeAttenuation:p,fov:m,framebufferHeight:A,devicePixelRatio:q,pointSizeMax:d},te=h===null?null:h.colors,X=h!==null&&h.readEveryLevel,M=h===null?f:h.readPointSize,U=t<3,B=-1,z=1/0,me=1/0,K=1/0,re=1/0,L=-1,oe=1/0,_e=1/0,O=1/0,be=0,se=a(T=>{be++;let F=te===null?255:te[T*4+3],N=F===H?2:F===fe?1:0,j=N!==2;if(!(j&&X)&&(g!==null?g[T]>w:T>=y)||!(l[T]>=$))return;let he=T*t,S=n[he],v=t>1?n[he+1]:0,P=t>2?n[he+2]:0,b=i[3]*S+i[7]*v+i[11]*P+i[15];if(!(b>0))return;let k=(i[2]*S+i[6]*v+i[10]*P+i[14])/b;if(k<-1||k>1)return;let V=(i[0]*S+i[4]*v+i[8]*P+i[12])/b,Z=(i[1]*S+i[5]*v+i[9]*P+i[13])/b,ce=(V*.5+.5)*_-c.x,Y=(.5-Z*.5)*x-c.y,W=Math.hypot(ce,Y);G.w=b,G.pointSize=j?M:f;let ue=Ze(G);if(W<=ue){let E=U?N:j?0:1,I=U?0:N;(E<z||E===z&&(b<K-1e-6*K||Math.abs(b-K)<=1e-6*K&&(I<me||I===me&&(W<re||W===re&&T<B))))&&(B=T,z=E,me=I,K=b,re=W);return}let we=W-ue;we>vt||(we<oe||we===oe&&T<L)&&(L=T,oe=we,_e=W,O=b)},"evaluatePoint");if(s===null){let T=r===null||g===null?null:r.indices;if(T===null||X){let F=X?o:y;for(let N=0;N<F;N++)se(N)}else for(let F=0;F<T.length;F++){let N=T[F];if(N>=o||g[N]>w)throw new RangeError(`Picking LOD compact index ${F} does not name an admitted source point.`);se(N)}}else{let T=d/2/q+vt,F=c.x/_*2-1,N=1-c.y/x*2,j=T/_*2,he=T/x*2;s.visitProjectedRectCandidates(i,{minX:F-j,maxX:F+j,minY:N-he,maxY:N+he},se)}return B!==-1?{cellIndex:B,examinedPointCount:be,screenDistance:re,depth:K}:{cellIndex:L,examinedPointCount:be,screenDistance:L===-1?1/0:_e,depth:L===-1?1/0:O}}a(Jr,"findScreenSpacePick");var bt=100-Le([211/255,211/255,211/255]),tr=8,rr=.4,St=8192,or=8,nr=4/Math.PI*Math.log(1/(1-rr));function Ke(e){return e<=.04045?e/12.92:((e+.055)/1.055)**2.4}a(Ke,"srgbToLinear");function Le(e){let t=.2126*Ke(e[0])+.7152*Ke(e[1])+.0722*Ke(e[2]);return t>216/24389?116*Math.cbrt(t)-16:24389/27*t}a(Le,"lightnessOf");function At(e,t){if(e===null||typeof e!="object"||e.length<3)throw new TypeError(`${t} must hold three channels from 0 to 1.`);for(let r=0;r<3;r++)if(!(e[r]>=0&&e[r]<=1))throw new RangeError(`${t} channel ${r} must be from 0 to 1, not ${e[r]}.`);return e}a(At,"requireRgb01");function ir(e){let t=Math.min(100,Math.max(0,e)),r=t>8?((t+16)/116)**3:t*(27/24389),o=r<=.0031308?12.92*r:1.055*r**(1/2.4)-.055;return Math.min(1,Math.max(0,o))}a(ir,"greyOfLightness");function He(e,t=new Float32Array(3)){At(e,"The background of the gray for 0");let r=Le(e),o=ir(r>=50?r-bt:r+bt);return t[0]=o,t[1]=o,t[2]=o,t}a(He,"zeroCellColor");function Je(e,t=new Float32Array(3)){At(e,"The background of cells not read");let r=He(e)[0],o=Le(e),n=Math.abs(Le([r,r,r])-o),s=Math.min(tr,n/2),l=[0,0,0],i=a(f=>{for(let p=0;p<3;p++)l[p]=e[p]+(r-e[p])*f;return l},"mixAt"),c=0,u=1;if(n>0)for(let f=0;f<40;f++){let p=(c+u)/2;Math.abs(Le(i(p))-o)<s?c=p:u=p}return i(c),t[0]=l[0],t[1]=l[1],t[2]=l[2],t}a(Je,"unreadCellColor");function io(e){let t=a(r=>Object.freeze(Array.from(r,o=>Math.round(o*255))),"bytes");return Object.freeze({zero:t(He(e)),unread:t(Je(e))})}a(io,"cellLayerColors");function ao(e,t,r){let o=t*4,n=e[o+3];return n===fe?Array.from(r.zero):n===H?Array.from(r.unread):[e[o],e[o+1],e[o+2]]}a(ao,"drawnCellRgb");function lo(e,t){let r=e.length>>>2,o=r-t;if(!(t>0)||o<0)return null;let n=Math.min(r,St),s=new Uint32Array(n);for(let f=0;f<n;f++)s[f]=Math.floor((f+.5)*r/n);let l=Math.min(o,St),i=new Uint32Array(l),c=0,u=0;for(let f=0;f<r&&c<l;f++)e[f*4+3]!==H&&(Math.floor((c+.5)*o/l)===u&&(i[c++]=f),u++);return Object.freeze({pointCount:r,readCount:o,all:s,read:i})}a(lo,"readCellProbes");var le={x:new Float32Array(0),y:new Float32Array(0),grid:new Uint8Array(0)};function Et(e,t,r){let{positions:o,dimension:n,transparency:s,mvpMatrix:l,width:i,height:c}=t;if(s!==null&&s[e]===0)return!1;let u=e*n,f=o[u],p=n>1?o[u+1]:0,m=n>2?o[u+2]:0,d=l[3]*f+l[7]*p+l[11]*m+l[15];if(!(d>0))return!1;let h=(l[0]*f+l[4]*p+l[8]*m+l[12])/d,g=(l[1]*f+l[5]*p+l[9]*m+l[13])/d,w=(l[2]*f+l[6]*p+l[10]*m+l[14])/d;return h>=-1&&h<=1&&g>=-1&&g<=1&&w>=-1&&w<=1?(r[0]=(h*.5+.5)*i,r[1]=(.5-g*.5)*c,r[2]=d,!0):!1}a(Et,"projectProbe");function so(e,t){if(e===null)return 1;let{width:r,height:o,pointSize:n,sizeAttenuation:s,fov:l,pointSizeMax:i}=t,c=t.readShare??1,u=e.all.length;le.x.length<u&&(le.x=new Float32Array(u),le.y=new Float32Array(u));let f=[0,0,0],p=0,m=1/0,d=-1/0,h=1/0,g=-1/0;for(let L=0;L<u;L++)Et(e.all[L],t,f)&&(le.x[p]=f[0],le.y[p]=f[1],p++,f[0]<m&&(m=f[0]),f[0]>d&&(d=f[0]),f[1]<h&&(h=f[1]),f[1]>g&&(g=f[1]));let w={w:1,pointSize:n,sizeAttenuation:s,fov:l,framebufferHeight:o,devicePixelRatio:1,pointSizeMax:i},y=0,_=0;for(let L=0;L<e.read.length;L++)Et(e.read[L],t,f)&&(y++,w.w=f[2],_+=2*Ze(w));if(p===0||y===0)return 1;let x=_/y,A=e.readCount*c*y/e.read.length,q=e.pointCount*p/u,G=Math.max(1,Math.floor(Math.sqrt(p/or))),te=Math.max((d-m)/G,x),X=Math.max((g-h)/G,x),M=Math.max(1,Math.ceil((d-m)/te)),U=Math.max(1,Math.ceil((g-h)/X));le.grid.length<M*U&&(le.grid=new Uint8Array(M*U));let B=le.grid;B.fill(0,0,M*U);let z=0;for(let L=0;L<p;L++){let oe=Math.min(M-1,Math.floor((le.x[L]-m)/te)),O=Math.min(U-1,Math.floor((le.y[L]-h)/X))*M+oe;B[O]===0&&(B[O]=1,z++)}let me=z*te*X,K=Math.sqrt(nr*me/A)/x,re=Math.sqrt(Math.max(1,q/A));return Math.min(re,Math.max(1,K))}a(so,"readCellSizeMultiplier");function $e(e,{pointCount:t=null,dimensionLevel:r=null,label:o="Figure-export LOD membership"}={}){return Ae(e,{pointCount:t??e?.pointCount,dimensionLevel:r,requireIndices:!0,owner:o})}a($e,"assertLodMembership");function mo(e,t,{pointCount:r,dimensionLevel:o,label:n}){let s=Ae(e,{pointCount:r,dimensionLevel:o,owner:n});if(s===null)return null;let l=et(t,{pointCount:r,label:`${n} draw order`}),i;if(s.indices!==null)i=new Uint32Array(s.indices);else if(l!==null)i=l.slice(0,s.count);else{i=new Uint32Array(s.count);for(let c=0;c<s.count;c++)i[c]=c}return Object.freeze({admissionLevels:s.admissionLevels,count:s.count,dimensionLevel:s.dimensionLevel,generationToken:Object.freeze({}),indices:i,lodLevel:s.lodLevel,pointCount:s.pointCount})}a(mo,"ownedLodMembership");function _o(e,t){return e===null||t===null?e===null&&t===null:typeof e=="object"&&!Array.isArray(e)&&Object.isFrozen(e)&&Number.isSafeInteger(e.admittedCount)&&e.admittedCount===t.count&&e.dimensionLevel===t.dimensionLevel&&e.generationToken===t.generationToken&&e.lodLevel===t.lodLevel&&e.pointCount===t.pointCount}a(_o,"matchesLodMembershipPresentation");function et(e,{pointCount:t,label:r="Figure export draw order"}){if(e===null)return null;if(!(e instanceof Uint32Array)||e.length!==t)throw new TypeError(`${r} must be null or a Uint32Array of ${t} source indices.`);return e}a(et,"assertDrawOrder");function Tt(e,t,r=null,o=!1){let n=e?.indices??t??null;if(r===null)return n;let s=Ve(r);if(!s.layered)return n;let l=s.unread>0&&o&&e!==null?t:n,i=n===null?r.length>>>2:n.length,c=l===null?r.length>>>2:l.length,u=0;for(let h=0;h<i;h++)r[(n===null?h:n[h])*4+3]===H&&u++;let f=c;if(l!==n||s.unread>0){f=0;for(let h=0;h<c;h++)r[(l===null?h:l[h])*4+3]!==H&&f++}let p=Oe(Uint32Array,u+f),m=0,d=a((h,g,w)=>{for(let y=0;y<g;y++){let _=h===null?y:h[y];r[_*4+3]===w&&(p[m++]=_)}},"take");d(n,i,H),d(l,c,fe);for(let h=0;h<c;h++){let g=l===null?h:l[h],w=r[g*4+3];w!==H&&w!==fe&&(p[m++]=g)}return p}a(Tt,"drawnSequence");function tt(e,t){if(e===null)return null;if(typeof e!="object"||!(Number.isFinite(e.readScale)&&e.readScale>=1)||typeof e.readEveryLevel!="boolean"||!Array.isArray(e.unreadColor)||e.unreadColor.length!==3||!e.unreadColor.every(r=>r>=0&&r<=1)||!Array.isArray(e.zeroColor)||e.zeroColor.length!==3||!e.zeroColor.every(r=>r>=0&&r<=1))throw new TypeError(`${t} must be null or {readScale >= 1, readEveryLevel, unreadColor, zeroColor: three channels 0..1 each}.`);return e}a(tt,"requireFigurePointLayers");function wo(e,t,r){if(e===null)return null;let{layered:o,unread:n}=Ve(e);return o?tt({readScale:n>0?t.readScale:1,readEveryLevel:n>0&&t.readEveryLevel,unreadColor:Array.from(Je(r)),zeroColor:Array.from(He(r))},"Figure point layers"):null}a(wo,"figurePointLayersOf");var ar=1e-6;function pe(e,t){if(typeof e!="number"||!Number.isFinite(e)||e<=0)throw new TypeError(`${t} must be a finite positive number.`);return e}a(pe,"requirePositive");function Ge({renderState:e,crop:t=null}){let r=pe(e?.viewportWidth,"Figure source viewport width"),o=pe(e?.viewportHeight,"Figure source viewport height"),n=dt(ht(t),r,o);return Object.freeze({viewportWidth:r,viewportHeight:o,x:n===null?0:n.x,y:n===null?0:n.y,width:n===null?r:n.width,height:n===null?o:n.height})}a(Ge,"figureSourceRect");function So({renderState:e,crop:t=null}){let r=Ge({renderState:e,crop:t});return r.width/r.height}a(So,"figureSourceAspect");function Eo({aspect:e,width:t,height:r}){return pe(e,"Figure plot aspect"),pe(t,"Figure plot box width"),pe(r,"Figure plot box height"),t/r<=e?{width:t,height:t/e}:{width:r*e,height:r}}a(Eo,"fitPlotSize");function Lt({renderState:e,plotRect:t,crop:r=null}){let o=Ge({renderState:e,crop:r}),n=pe(t?.width,"Figure plot width")/o.width,s=pe(t?.height,"Figure plot height")/o.height;if(Math.abs(n/s-1)>ar)throw new RangeError("Figure plot rectangle must have its view's aspect (fitPlotSize); a figure is never letterboxed.");let l=t.x-o.x*n,i=t.y-o.y*s;return{source:o,scale:n,viewportToPlot:a((c,u)=>({x:l+c*n,y:i+u*s}),"viewportToPlot")}}a(Lt,"createPlotPlacement");function ye(e,t,r,o,n,s){let l=e[3]*r+e[7]*o+e[11]*n+e[15];if(!(l>0)||l===1/0)return!1;let i=(e[0]*r+e[4]*o+e[8]*n+e[12])/l,c=(e[1]*r+e[5]*o+e[9]*n+e[13])/l,u=(e[2]*r+e[6]*o+e[10]*n+e[14])/l;if(!(i>=-1&&i<=1&&c>=-1&&c<=1&&u>=-1&&u<=1))return!1;let f=(i*.5+.5)*t.viewportWidth-t.x,p=(.5-c*.5)*t.viewportHeight-t.y;return f>=0&&f<=t.width&&p>=0&&p<=t.height?(s[0]=f,s[1]=p,s[2]=u,!0):!1}a(ye,"projectIntoSource");function Ao(e){return{x:e.x/e.viewportWidth,y:e.y/e.viewportHeight,width:e.width/e.viewportWidth,height:e.height/e.viewportHeight}}a(Ao,"sourceRect01");function To({source:e,deviceWidth:t,deviceHeight:r,zoomLimit:o}){pe(o,"Figure raster zoom limit");for(let[c,u]of[["width",t],["height",r]])if(!Number.isSafeInteger(u)||u<=0)throw new TypeError(`Figure raster device ${c} must be a positive integer.`);let n=Math.min(t/e.width,r/e.height);if(n<=o)return{width:t,height:r,zoom:n,exact:!0};let s=o/n,l=Math.max(1,Math.round(t*s)),i=Math.max(1,Math.round(r*s));return{width:l,height:i,zoom:Math.min(l/e.width,i/e.height),exact:!1}}a(To,"planPlotRaster");var lr=3e38,Be=`
// A cell its embedding does not place (rendering/unplaced-positions.js):
// rejected before rasterization.
bool isUnplacedPosition(vec3 position) { return abs(position.x) > 1.0e38; }
`;function Io(e,t,r){let o=e[r*t];return o!==o}a(Io,"isUnplacedCell");var Ue=new WeakMap,rt=new WeakSet;function Co(e){return rt.has(e)}a(Co,"isProvenCellRows");function Pt(e){rt.add(e)}a(Pt,"markProvenCellRows");function No(e,t){if(!Number.isSafeInteger(t)||t<0)throw new RangeError(`An unplaced-cell count is a whole number of cells, not ${String(t)}.`);Ue.set(e,t)}a(No,"publishUnplacedCount");function sr(e,t){let r=Ue.get(e);if(r===void 0){r=0;for(let o=0;o<e.length;o+=t){let n=e[o];n!==n&&r++}Ue.set(e,r)}return r}a(sr,"unplacedCountOf");function Oo(e,t,r){let o=0;for(let n=0;n<e.length;n+=t){let s=e[n];if(s!==s){for(let l=1;l<t;l++){let i=e[n+l];if(i===i)throw new RangeError(`${r}: cell ${n/t} is NaN in one axis but not in every axis.`)}o++;continue}for(let l=0;l<t;l++)if(!Number.isFinite(e[n+l]))throw new RangeError(`${r} value ${n+l} must be finite, or NaN in every axis of an unplaced cell.`)}return Ue.set(e,o),rt.add(e),e}a(Oo,"requirePlacedOrUnplacedRows");function Fo(e,t){return Rt(e,t,lr)}a(Fo,"positionsForGpu");function Mo(e,t){return Rt(e,t,0)}a(Mo,"vectorsForGpu");function Rt(e,t,r){if(sr(e,t)===0)return e;let o=Oe(Float32Array,e.length);o.set(e);for(let n=0;n<o.length;n+=t){let s=o[n];s!==s&&o.fill(r,n,n+t)}return o}a(Rt,"rowsForGpu");var cr=Float32Array.BYTES_PER_ELEMENT;function ur(e,t="Position dimension"){if(e!==1&&e!==2&&e!==3)throw new RangeError(`${t} must be exactly 1, 2, or 3.`);return e}a(ur,"requirePositionDimension");function ve(e,t,r="Positions",{allowEmpty:o=!1,pointCount:n=null}={}){let s=ur(t,`${r} dimension`);if(!(e instanceof Float32Array)||e.length%s!==0||!o&&e.length===0)throw new TypeError(`${r} must be a ${o?"":"non-empty "}Float32Array with exactly ${R(s,"value")} per point.`);let l=e.length/s;if(n!==null&&l!==n)throw new RangeError(`${r} must contain exactly ${R(n*s,"value")} (${R(n,"point")} of ${s}); received ${e.length}.`);return l}a(ve,"requirePositionArray");function Go(e,t,r,o){let n=r*t;return o[0]=e[n],o[1]=t>1?e[n+1]:0,o[2]=t>2?e[n+2]:0,o}a(Go,"readPositionXYZ");var ot=new WeakMap,It=new WeakSet;function Uo(e){return It.has(e)}a(Uo,"isProvenFiniteFloat32Array");function Bo(e){It.add(e)}a(Bo,"markProvenFiniteFloat32Array");function jo(e,t,r){ve(e,t,"Bounds positions");let o=[0,0,0],n=[0,0,0];for(let s=0;s<3;s++)if(o[s]=r.min[s],n[s]=r.max[s],!Number.isFinite(o[s])||!Number.isFinite(n[s])||o[s]>n[s]||s>=t&&(o[s]!==0||n[s]!==0))throw new RangeError("Published position bounds must be finite, ordered, and zero on absent axes.");ot.set(e,{dimension:t,bounds:Object.freeze({min:Object.freeze(o),max:Object.freeze(n)})}),Pt(e)}a(jo,"publishPositionBounds");function ko(e,t){ve(e,t,"Bounds positions");let r=ot.get(e);if(r!==void 0&&r.dimension===t)return r.bounds;let o=[0,0,0],n=[0,0,0];for(let l=0;l<t;l++){let i=1/0,c=-1/0;for(let u=l;u<e.length;u+=t){let f=e[u];f<i&&(i=f),f>c&&(c=f)}o[l]=i<=c?i:0,n[l]=i<=c?c:0}let s=Object.freeze({min:Object.freeze(o),max:Object.freeze(n)});return ot.set(e,{dimension:t,bounds:s}),s}a(ko,"readPositionBounds");function Yo(e,t){return e*t*cr}a(Yo,"positionByteLength");function Qo(e,t,r){if(!Number.isFinite(e)||!Number.isFinite(t))throw new TypeError("Figure-export coordinates must be finite numbers.");if(r===null||typeof r!="object"||Array.isArray(r)||Object.getPrototypeOf(r)!==Object.prototype||Object.keys(r).sort().join(",")!=="center,scale"||!Array.isArray(r.center)||r.center.length!==3||r.center.some(s=>!Number.isFinite(s))||!Number.isFinite(r.scale)||r.scale<=0)throw new TypeError("Figure-export normalization transform must contain exact finite center and positive scale values.");let{scale:o,center:n}=r;return{x:e/o+n[0],y:t/o+n[1]}}a(Qo,"denormalizeXY");function Ko({positions:e,dimension:t,transparency:r=null,lodMembership:o=null,mvpMatrix:n,viewportWidth:s,viewportHeight:l,crop:i=null}){if(!e||!n)return!1;let c=Ge({renderState:{viewportWidth:s,viewportHeight:l},crop:i}),u=ve(e,t,"Figure-export positions",{allowEmpty:!0});$e(o,{pointCount:u});let f=o?.indices??null,p=f?.length??u,m=new Float64Array(3);for(let d=0;d<p;d++){let h=f===null?d:f[d],g=r?r[h]??1:1;if((Number.isFinite(g)?g:1)<$)continue;let y=h*t,_=e[y],x=t>1?e[y+1]:0,A=t>2?e[y+2]:0;if(ye(n,c,_,x,A,m))return!0}return!1}a(Ko,"sourceHasDrawnCells");var nt=8,it=6,fr=90;function Ct({highlightArray:e,transparency:t,lodMembership:r=null}){if(!(e instanceof Uint8Array))return 0;let o=0;if(r!==null){let n=r.indices;for(let s=0;s<n.length;s++){let l=n[s];(e[l]??0)<Te||t!==null&&(t[l]??0)<$||o++}return o}for(let n=0;n<e.length;n++)e[n]<Te||t!==null&&(t[n]??0)<$||o++;return o}a(Ct,"countHighlightedVisiblePoints");function nn({count:e,plotRect:t,fontSizePx:r}){if(!Number.isSafeInteger(e)||e<=0)return null;let o=`n = ${ft(e)} selected`,n=Math.max(16,Math.round(r*1.35)),s=Math.min(Math.max(1,t.width-nt*2),Math.max(fr,Math.round(o.length*(r*.62)+it*2))),l=t.x+nt,i=t.y+nt;return{label:o,x:l,y:i,width:s,height:n,textX:l+it,textY:i+n-it}}a(nn,"buildSelectionBadge");function an(e,t,r,o){return`<g font-family="${qe(t)}" font-size="${r}" fill="${o.surfaceInk}"><rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" fill="${o.surface}" fill-opacity="0.85" stroke="${o.frame}" stroke-width="1"/><text x="${e.textX}" y="${e.textY}" stroke="none">${qe(e.label)}</text></g>`}a(an,"renderSvgSelectionBadge");function ln(e,t,r,o,n){e.save(),e.globalAlpha=.85,e.fillStyle=n.surface,e.fillRect(t.x,t.y,t.width,t.height),e.globalAlpha=1,e.strokeStyle=n.frame,e.lineWidth=1,e.strokeRect(t.x,t.y,t.width,t.height),e.fillStyle=n.surfaceInk,e.font=`${o}px ${r}`,e.textAlign="left",e.textBaseline="alphabetic",e.fillText(t.label,t.textX,t.textY),e.restore()}a(ln,"drawCanvasSelectionBadge");var at=`
// Atmospheric fog (Beer-Lambert), shared by every fogged layer (fog-shaders.js).
// u_fogScale = log2(e) * extinction / span, zero when fog is off.
uniform float u_fogNear;
uniform float u_fogScale;

float fogTransmittance(float viewDistance) {
  return exp2(-u_fogScale * max(viewDistance - u_fogNear, 0.0));
}

// The opacity fog leaves a translucent layer: it fades toward what is behind.
float fogOpacity(float transmittance) {
  return transmittance * (0.1 + 0.9 * transmittance);
}
`;function hr(e,t,r){let o=Math.max(r-t,1e-4);return e*e*.6*Math.LOG2E/o}a(hr,"fogScale");function un(e,t,r,o,n,s){t!==null&&e.uniform1f(t,n),r!==null&&e.uniform1f(r,hr(o,n,s))}a(un,"writeFogUniforms");function fn(e){return e*(.1+.9*e)}a(fn,"fogOpacityAt");var lt=`
// The texel of item \`index\` in a linear texture (rendering/linear-texture.js):
// shape.x = log2(width), shape.y = rows per layer. (\`layout\` is a GLSL
// keyword, which Firefox's compiler rejects as a name.)
ivec3 linearTexel(int index, ivec2 shape) {
  int row = index >> shape.x;
  int layer = row / shape.y;
  return ivec3(index & ((1 << shape.x) - 1), row - layer * shape.y, layer);
}
`;function Nt(e){return 31-Math.clz32(e)}a(Nt,"floorLog2");function dr(e,t,r){if(!Number.isSafeInteger(e)||e<0)throw new RangeError(`Linear texture item count must be a non-negative safe integer, not ${e}.`);if(!Number.isSafeInteger(t)||t<=0)throw new RangeError("Linear texture needs a positive MAX_TEXTURE_SIZE.");if(!Number.isSafeInteger(r)||r<=0)throw new RangeError("Linear texture needs a positive MAX_ARRAY_TEXTURE_LAYERS.");let o=Math.max(1,e),n=Nt(t),s=o<=1?0:Nt(o-1)+1,l=Math.min(n,s),i=Math.ceil(o/2**l),c=i===1?o:2**l,u=Math.ceil(i/t);if(u>r)throw new RangeError(`${R(e,"item")} need ${u} texture layers; this GPU allows ${r}.`);let f=Math.ceil(i/u);if(o>2**31-1)throw new RangeError(`${R(e,"item")} exceed the shader's integer index range.`);return Object.freeze({itemCount:e,width:c,widthShift:l,rowsPerLayer:f,layers:u,rows:i,texels:c*f*u})}a(dr,"planLinearTexture");function gn(e,t){if(!Number.isSafeInteger(t)||t<0||t>e.texels)throw new RangeError(`A linear texture of ${R(e.texels,"texel")} cannot hold ${Number.isSafeInteger(t)?R(t,"item"):String(t)}.`);return Object.freeze({...e,itemCount:t,rows:Math.ceil(Math.max(1,t)/e.width)})}a(gn,"resizedLinearPlan");function mn(e,t){return dr(t,e.getParameter(e.MAX_TEXTURE_SIZE),e.getParameter(e.MAX_ARRAY_TEXTURE_LAYERS))}a(mn,"planLinearTextureFor");function _n(e,t,r){let o=e.TEXTURE_2D_ARRAY;e.texParameteri(o,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(o,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(o,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(o,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texStorage3D(o,1,t,r.width,r.rowsPerLayer,r.layers)}a(_n,"allocateLinearTexture");function wn(e,t,r,o,n,s,l=0,i=t.rows){let c=t.itemCount,u=t.width,f=Math.min(i,Math.ceil(c/u)),p=n.length>=f*u*s?f:Math.floor(c/u),m=0,d=Math.max(0,l);for(;d<f;){let h=Math.floor(d/t.rowsPerLayer),g=Math.min(f,(h+1)*t.rowsPerLayer),w=d-h*t.rowsPerLayer,y=Math.min(g,p);if(d<y){let q=d*u*s,G=y*u*s;e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,w,h,u,y-d,1,r,o,n,q),m+=(G-q)*n.BYTES_PER_ELEMENT,d=y;continue}let _=c-d*u,x=d*u*s,A=x+_*s;e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,w,h,_,1,1,r,o,n,x),m+=(A-x)*n.BYTES_PER_ELEMENT,d+=1}return m}a(wn,"writeLinearTextureRows");function yn(e,t,r,o,n,s,l,i,c=0){if(!(Number.isSafeInteger(l)&&Number.isSafeInteger(i)&&l>=0&&i>=l&&i<=t.itemCount))throw new RangeError(`Linear texture items [${l}, ${i}) are outside its ${t.itemCount}.`);if(!(Number.isSafeInteger(c)&&c>=0&&c<=l&&(i-c)*s<=n.length))throw new RangeError(`Linear texture items [${l}, ${i}) are not all in data holding items from ${c}.`);let u=t.width,f=0,p=l,m=a((d,h)=>{let g=Math.floor(d/u),w=Math.floor(g/t.rowsPerLayer);e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,d-g*u,g-w*t.rowsPerLayer,w,h,1,1,r,o,n,(d-c)*s),f+=h*s*n.BYTES_PER_ELEMENT},"writeRun");if(p%u!==0&&p<i){let d=Math.min(i,(Math.floor(p/u)+1)*u)-p;m(p,d),p+=d}for(;i-p>=u;){let d=p/u,h=Math.floor(d/t.rowsPerLayer),g=Math.min(Math.floor((i-p)/u),(h+1)*t.rowsPerLayer-d);e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,d-h*t.rowsPerLayer,h,u,g,1,r,o,n,(p-c)*s),f+=g*u*s*n.BYTES_PER_ELEMENT,p+=g*u}return p<i&&m(p,i-p),f}a(yn,"writeLinearTextureItems");function xn(e,t,r){t!==null&&e.uniform2i(t,r.widthShift,r.rowsPerLayer)}a(xn,"setLinearLayoutUniform");var Ln=2,Ot=Object.freeze({ambient:.5,diffuse:.5}),je=Ot.ambient.toFixed(2),ke=Ot.diffuse.toFixed(2),Pn=`#version 300 es
precision highp float;

// Two vertex streams: position (float32, 1-3 components; missing axes read as 0)
// and color.rgba (uint8 normalized)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
${De}
${at}
// Alpha in source order, one R8 texel a point, as a linear texture
// (rendering/linear-texture.js), for alpha-only updates.
uniform lowp sampler2DArray u_alphaTex;
uniform ivec2 u_alphaLayout;
uniform bool u_useAlphaTex;
// The store order's slot map (slot -> source point), R32UI, so the alpha of
// a point drawn from a reordered store is found exactly at any index. Slots
// from u_orderedSlots on hold their own point (rendering/high-perf/
// store-order.js); 0 for a store in source order.
uniform highp usampler2DArray u_lodIndexTex;
uniform ivec2 u_lodIndexLayout;
uniform int u_orderedSlots;
// The first slot of the store segment drawn: gl_VertexID counts from it
// (rendering/high-perf/point-store-segments.js).
uniform int u_slotBase;
// Which cells this pass draws, by the layer their color's alpha byte names
// (alpha-visibility.js): 0 every one; 1 the grey beneath the colored cells
// (BENEATH_ALPHA_BYTE, 254); 2 the colored cells (255); 3 the cells not read
// (UNREAD_ALPHA_BYTE, 253). A field with lower layers is drawn a layer a
// pass, bottom first (3, 1, 2), so each lies over the one before in 2-D
// blending and wins depth ties in 3-D, at every level of detail and culled
// range.
uniform int u_drawPass;
// The color of a cell not read: the background's, faded toward the grey
// for 0 (rendering/read-cell-layer.js, unreadCellColor). Its own RGB bytes
// are not drawn.
uniform vec3 u_unreadColor;
// The grey of the cells beneath (no value: a gene's 0, a missing value), made
// from the background (rendering/read-cell-layer.js, zeroCellColor). Their
// own RGB bytes are not drawn.
uniform vec3 u_zeroColor;
// The cells of this draw lie beneath the others (pass 1, or a figure's first
// range): with depth tested, each yields to any cell up to one drawn point
// diameter behind it, so an expressing cell on the same surface as the grey
// around it shows in 3-D too, while a cell well in front still occludes.
uniform bool u_yieldDepth;
${lt}
${Be}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;
// Fog transmittance (1 is unfogged), and the opacity it leaves a translucent
// point (fog-shaders.js). Full thins the point by the opacity; Sculpted is
// opaque and mixes its color by the transmittance.
flat out float v_fogT;
flat out float v_fogOpacity;

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled, otherwise use vertex attribute
  float alpha;
  if (u_useAlphaTex) {
    // Integer addressing throughout: a float index loses exactness at 2^24.
    int slot = u_slotBase + gl_VertexID;
    int origIdx = slot < u_orderedSlots
      ? int(texelFetch(u_lodIndexTex, linearTexel(slot, u_lodIndexLayout), 0).r)
      : slot;
    alpha = texelFetch(u_alphaTex, linearTexel(origIdx, u_alphaLayout), 0).r;
  } else {
    alpha = a_color.a;
  }

  // The sprite: perspective size and the cap (rendering/point-sprite.js).
  gl_PointSize = pointSpriteSize(eyeDepth);

  // Reject invisible points before rasterisation.
  //
  // Shrinking the point is not enough: ALIASED_POINT_SIZE_RANGE starts at 1.0
  // on this driver, so gl_PointSize = 0.0 is clamped back to one pixel and the
  // point is assembled, rasterised, and shaded before the fragment discard
  // throws it away. Moving the vertex outside the clip volume rejects it up
  // front, which is what makes hiding cells cheaper than showing them instead
  // of more expensive. The size is still zeroed as a second line of defence.
  if (u_yieldDepth) {
    // One drawn diameter in eye units at this depth (u_pointScale: pixels
    // per world unit at unit depth, over 100), the depth moved back by it.
    float diameter = gl_PointSize * eyeDepth / max(100.0 * u_pointScale, 1e-6);
    vec4 yielded = u_projectionMatrix * vec4(eyePos.xy, eyePos.z - diameter, 1.0);
    gl_Position.z = clamp(yielded.z / yielded.w, -1.0, 1.0) * gl_Position.w;
  }
  // The layer byte, exact: a normalized byte is k / 255.
  int layer = int(a_color.a * 255.0 + 0.5);
  if (alpha < 0.01 || isUnplacedPosition(a_position)
    || (u_drawPass == 1 && layer != 254) || (u_drawPass == 2 && layer != 255) || (u_drawPass == 3 && layer != 253)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_fogT = fogTransmittance(length(eyePos.xyz));
  v_fogOpacity = fogOpacity(v_fogT);

  // The passes of the lower layers draw them in their own colors (a
  // figure's raster bakes those into the colors and draws in pass 0).
  v_color = u_drawPass == 3 ? u_unreadColor : (u_drawPass == 1 ? u_zeroColor : a_color.rgb);
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`,Rn=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  // One discard for both cases — a hidden point (second line of defence
  // behind HP_VS_FULL's clip-volume rejection) and a sprite corner outside the
  // disc. Two separate discards, the first ahead of everything else, cost 12%
  // of a dense antialiased 2-D frame (1M points, 4x MSAA, ANGLE Metal on an
  // Apple M1 Pro: 35.6 ms against 31.4 ms) for the same pixels.
  if (v_alpha < 0.01 || r2 > 1.0) discard;

  // Sphere normal for lighting
  vec3 normal = vec3(coord.x, -coord.y, sqrt(1.0 - r2));

  // Blinn-Phong (FULL_LIGHTING), white specular of exponent 32 (five
  // squarings) and weight 0.3.
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float specular = max(dot(normal, u_halfDir), 0.0);
  specular *= specular; specular *= specular; specular *= specular;
  specular *= specular; specular *= specular;
  vec3 litColor = v_color * (${je} + ${ke} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = vec4(shadedColor, v_alpha * v_fogOpacity);
}
`,In=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogOpacity;

uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

// Pixels per unit of (1 - r^2) / 2 across the disc rim: one pixel wide from a
// radius of four pixels, narrower below so the smallest points stay crisp.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // The cases in which HP_FS_FULL discards, as a fragment that blends to
  // nothing: a hidden point and the sprite corners outside the disc.
  bool covered = v_alpha >= 0.01 && coverage > 0.0;

  vec3 normal = vec3(coord.x, -coord.y, sqrt(max(1.0 - r2, 0.0)));
  float NdotL = max(dot(normal, u_lightDir), 0.0);
  float specular = max(dot(normal, u_halfDir), 0.0);
  specular *= specular; specular *= specular; specular *= specular;
  specular *= specular; specular *= specular;
  vec3 litColor = v_color * (${je} + ${ke} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = covered ? vec4(shadedColor, v_alpha * v_fogOpacity * coverage) : vec4(0.0);
}
`,Cn=`#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
${De}

// Alpha in source order, one R8 texel a point, as a linear texture
// (rendering/linear-texture.js), for alpha-only updates.
uniform lowp sampler2DArray u_alphaTex;
uniform ivec2 u_alphaLayout;
uniform bool u_useAlphaTex;
// The store order's slot map (slot -> source point), R32UI, so the alpha of
// a point drawn from a reordered store is found exactly at any index. Slots
// from u_orderedSlots on hold their own point (rendering/high-perf/
// store-order.js); 0 for a store in source order.
uniform highp usampler2DArray u_lodIndexTex;
uniform ivec2 u_lodIndexLayout;
uniform int u_orderedSlots;
// The first slot of the store segment drawn: gl_VertexID counts from it
// (rendering/high-perf/point-store-segments.js).
uniform int u_slotBase;
// Which cells this pass draws, by the layer their color's alpha byte names
// (alpha-visibility.js): 0 every one; 1 the grey beneath the colored cells
// (BENEATH_ALPHA_BYTE, 254); 2 the colored cells (255); 3 the cells not read
// (UNREAD_ALPHA_BYTE, 253). A field with lower layers is drawn a layer a
// pass, bottom first (3, 1, 2), so each lies over the one before in 2-D
// blending and wins depth ties in 3-D, at every level of detail and culled
// range.
uniform int u_drawPass;
// The color of a cell not read: the background's, faded toward the grey
// for 0 (rendering/read-cell-layer.js, unreadCellColor). Its own RGB bytes
// are not drawn.
uniform vec3 u_unreadColor;
// The grey of the cells beneath (no value: a gene's 0, a missing value), made
// from the background (rendering/read-cell-layer.js, zeroCellColor). Their
// own RGB bytes are not drawn.
uniform vec3 u_zeroColor;
// The cells of this draw lie beneath the others (pass 1, or a figure's first
// range): with depth tested, each yields to any cell up to one drawn point
// diameter behind it, so an expressing cell on the same surface as the grey
// around it shows in 3-D too, while a cell well in front still occludes.
uniform bool u_yieldDepth;
${lt}
${Be}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;

void main() {
  // The same two products as HP_VS_FULL, not one model-view-projection
  // product: depth is then bit-identical across qualities, so the same point
  // wins every near-tie in every quality.
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Fetch alpha from texture if enabled
  float alpha;
  if (u_useAlphaTex) {
    // Integer addressing throughout: a float index loses exactness at 2^24.
    int slot = u_slotBase + gl_VertexID;
    int origIdx = slot < u_orderedSlots
      ? int(texelFetch(u_lodIndexTex, linearTexel(slot, u_lodIndexLayout), 0).r)
      : slot;
    alpha = texelFetch(u_alphaTex, linearTexel(origIdx, u_alphaLayout), 0).r;
  } else {
    alpha = a_color.a;
  }

  // The same sprite as HP_VS_FULL and HP_VS_HIGHLIGHT (one GLSL function,
  // rendering/point-sprite.js). Shader quality selects shading, never
  // geometry: a higher ceiling here once made "light" and "ultralight" draw
  // larger points than "full" at close range, which is both a different
  // picture and — because point area is quadratic in the size — more fill
  // (a ceiling of 192 measured 1.23x the GPU frame time at point size 40 and
  // 1.90x at 60).
  gl_PointSize = pointSpriteSize(eyeDepth);

  // Reject invisible points before rasterisation — see HP_VS_FULL. This shader
  // also backs the ultralight program, whose fragment shader does not discard,
  // so without the clip rejection a hidden point still writes depth and
  // occludes the visible points behind it.
  if (u_yieldDepth) {
    // One drawn diameter in eye units at this depth (u_pointScale: pixels
    // per world unit at unit depth, over 100), the depth moved back by it.
    float diameter = gl_PointSize * eyeDepth / max(100.0 * u_pointScale, 1e-6);
    vec4 yielded = u_projectionMatrix * vec4(eyePos.xy, eyePos.z - diameter, 1.0);
    gl_Position.z = clamp(yielded.z / yielded.w, -1.0, 1.0) * gl_Position.w;
  }
  // The layer byte, exact: a normalized byte is k / 255.
  int layer = int(a_color.a * 255.0 + 0.5);
  if (alpha < 0.01 || isUnplacedPosition(a_position)
    || (u_drawPass == 1 && layer != 254) || (u_drawPass == 2 && layer != 255) || (u_drawPass == 3 && layer != 253)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  // The passes of the lower layers draw them in their own colors (a
  // figure's raster bakes those into the colors and draws in pass 0).
  v_color = u_drawPass == 3 ? u_unreadColor : (u_drawPass == 1 ? u_zeroColor : a_color.rgb);
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`,Nn=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  // One discard for a hidden point and a corner outside the disc; see
  // HP_FS_FULL.
  if (v_alpha < 0.01 || r2 > 1.0) discard;

  fragColor = vec4(v_color, v_alpha);
}
`,On=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

// Pixels per unit of (1 - r^2) / 2 across the disc rim: one pixel wide from a
// radius of four pixels, narrower below so the smallest points stay crisp.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // The cases in which HP_FS_LIGHT discards, as a fragment that blends to
  // nothing: a hidden point (the vertex shader has already moved it out of
  // the clip volume, so this is the second line of defence), and the sprite
  // corners outside the disc. The rim between is antialiased; see
  // HP_FS_FULL_NO_DEPTH.
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(v_color, v_alpha * coverage) : vec4(0.0);
}
`,Fn=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, v_alpha);
}
`,D=Object.freeze({skyAmbient:1,groundAmbient:.5,ambientWeight:.25,wrap:.25,diffuseWeight:1,edgeOcclusion:.22,sheenWeight:.45}),ge=a(e=>{let t=String(e);return t.includes(".")||t.includes("e")?t:`${t}.0`},"GLSL_FLOAT"),Ft=`
// Pixels per unit of (1 - r^2) / 2 across the disc rim; see
// HP_FS_FULL_NO_DEPTH.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

// Sculpted lighting of one sphere normal, in linear light, before the
// centre normalisation. Mirrors sculptedCenterShade() in JavaScript.
float sculptedShade(vec3 normal, out float sky) {
  sky = normal.y * 0.5 + 0.5;
  float ambient = mix(${ge(D.groundAmbient)}, ${ge(D.skyAmbient)}, sky);
  float wrapped = clamp(
    (dot(normal, u_lightDir) + ${ge(D.wrap)}) * ${ge(1/(1+D.wrap))},
    0.0,
    1.0
  );
  float occlusion = mix(${ge(D.edgeOcclusion)}, 1.0, smoothstep(0.0, 0.75, normal.z));
  return (
    ${ge(D.ambientWeight)} * ambient +
    ${ge(D.diffuseWeight)} * wrapped * wrapped
  ) * occlusion;
}

vec3 sculptedColor(vec2 coord, float r2) {
  // The antialiased rim reaches half a pixel past the silhouette; there the
  // normal is the silhouette's own, not a longer-than-unit vector that would
  // light the rim brighter than the sphere.
  vec2 disc = coord * inversesqrt(max(r2, 1.0));
  vec3 normal = vec3(disc.x, -disc.y, sqrt(max(1.0 - r2, 0.0)));
  vec3 albedo = v_color * v_color;
  float sky;
  float shade = sculptedShade(normal, sky) * u_invCenterShade;
  // Gloss: exponent 32 (five squarings), faded in between sprite radii of two
  // and six pixels.
  float gloss = max(dot(normal, u_halfDir), 0.0);
  gloss *= gloss; gloss *= gloss; gloss *= gloss; gloss *= gloss; gloss *= gloss;
  gloss *= smoothstep(2.0, 6.0, v_radiusPx);
  vec3 lit = albedo * shade
    + (${ge(D.sheenWeight)} * gloss) * mix(vec3(1.0), albedo, 0.25);
  vec3 shaded = sqrt(lit);
  return mix(u_fogColor, mix(v_color, shaded, u_lightingStrength), v_fogT);
}
`,Mn=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogT;

uniform float u_lightingStrength;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;
uniform float u_invCenterShade;
uniform float u_coverageFloor;

out vec4 fragColor;
${Ft}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  // One discard: a hidden point (second line of defence behind HP_VS_FULL's
  // clip-volume rejection) and a fragment outside the disc's coverage.
  if (v_alpha < 0.01 || coverage <= u_coverageFloor) discard;
  fragColor = vec4(
    sculptedColor(coord, r2),
    u_coverageFloor > 0.0 ? 1.0 : coverage
  );
}
`,zn=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;
flat in float v_fogT;

uniform float u_lightingStrength;
uniform vec3 u_fogColor;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;
uniform float u_invCenterShade;

out vec4 fragColor;
${Ft}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(sculptedColor(coord, r2), v_alpha * coverage) : vec4(0.0);
}
`;function pr(e){let r=D.groundAmbient+(D.skyAmbient-D.groundAmbient)*.5,o=Math.min(1,Math.max(0,(e[2]+D.wrap)/(1+D.wrap)));return D.ambientWeight*r+D.diffuseWeight*o*o}a(pr,"sculptedCenterShade");function Mt(e,t,r,o,n,s){let l=e.modelView,i=t,c=r;for(let h=0;h<4;h++){let g=c[h*4],w=c[h*4+1],y=c[h*4+2],_=c[h*4+3];l[h*4]=i[0]*g+i[4]*w+i[8]*y+i[12]*_,l[h*4+1]=i[1]*g+i[5]*w+i[9]*y+i[13]*_,l[h*4+2]=i[2]*g+i[6]*w+i[10]*y+i[14]*_,l[h*4+3]=i[3]*g+i[7]*w+i[11]*y+i[15]*_}let u=o[0],f=o[1],p=o[2]+1,m=Math.hypot(u,f,p),d=e.halfDir;return m>0?(d[0]=u/m,d[1]=f/m,d[2]=p/m):(d[0]=0,d[1]=0,d[2]=1),e.invCenterShade=1/pr(o),Me(n,s)}a(Mt,"writePointShaderFrame");var Dn=Object.freeze({full:Object.freeze({scale:1.75,ringWidth:.42,haloStrength:.65,haloShape:0,ringStyle:0,animated:!0}),sculpted:Object.freeze({scale:1.75,ringWidth:.42,haloStrength:.65,haloShape:0,ringStyle:0,animated:!1}),light:Object.freeze({scale:1.7,ringWidth:.44,haloStrength:.6,haloShape:0,ringStyle:1,animated:!1}),ultralight:Object.freeze({scale:1.65,ringWidth:.46,haloStrength:.55,haloShape:.35,ringStyle:2,animated:!1})}),ct=Object.freeze([.4,.85,1]),gr=Object.freeze([0,0,0]),mr=Object.freeze([1,1,1]),st=a(e=>e<=.04045?e/12.92:((e+.055)/1.055)**2.4,"linearChannel");function _r(e){return(.2126*st(e[0])+.7152*st(e[1])+.0722*st(e[2])+.05)**2>=.05*1.05?gr:mr}a(_r,"highlightRingColorFor");var Hn=_r(ct),zt=1.08,Dt=1.65;function $n({scale:e,ringWidth:t}){let r=zt/e,o=(r*Dt-r)*.5*(.5+t*.5),n=r+o*2;if(n>.95){let s=.95/n;r*=s,n*=s}return{inner:r*e,outer:n*e}}a($n,"highlightRingRadii");function Gn(e){return .5+.5*Math.sin(e*4)}a(Gn,"highlightGlowAt");var Un=`#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed - we only use alpha for visibility

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
${De}
uniform float u_highlightScale; // How much larger the highlight ring is (e.g., 1.5)
// The GPU's largest point (ALIASED_POINT_SIZE_RANGE[1]), in the pixels drawn into.
uniform float u_gpuPointSizeMax;

${at}
${Be}
flat out float v_alpha;
flat out float v_fogOpacity; // The opacity fog leaves this ring (fog-shaders.js)

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // The dot's own sprite (rendering/point-sprite.js: the same function as
  // the point shaders), so the ring sits on the dot at every depth.
  float dotSize = pointSpriteSize(eyeDepth);

  // The ring is a constant multiple of the dot, within the GPU's largest
  // point (u_gpuPointSizeMax: asking for more is undefined, not clamped).
  gl_PointSize = clamp(dotSize * u_highlightScale, 1.0, u_gpuPointSizeMax);

  v_fogOpacity = fogOpacity(fogTransmittance(length(eyePos.xyz)));

  // Reject unhighlighted points before rasterisation — see HP_VS_FULL. Zeroing
  // the size alone does not hide anything: the driver clamps it back to one
  // pixel, so the point is still assembled, rasterised and shaded.
  //
  // Two facts elsewhere used to make that harmless, and this shader relies on
  // neither. Both producers pack only points at or above MIN_VISIBLE_ALPHA_BYTE
  // — 3/255 = 0.0118, above this 0.01 threshold — so nothing can reach this
  // branch today (highlight-renderer.js, and the figure-export path in
  // app/ui/modules/figure-export/utils/webgl-point-rasterizer.js); and both draw
  // sites run depthMask(false). A producer that stops compacting, or a pass that
  // starts writing depth, is then a change to those files and not to this one.
  if (a_color.a < 0.01 || isUnplacedPosition(a_position)) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_alpha = a_color.a;
}
`,Bn=`#version 300 es
precision highp float;

flat in float v_alpha;
flat in float v_fogOpacity; // The opacity fog leaves this ring (HP_VS_HIGHLIGHT)

uniform vec3 u_highlightColor; // The dot (HIGHLIGHT_COLOR)
// The ring around it (highlightRingColorFor(u_highlightColor)): black around
// a light dot, so the pair reads against any coloring (F162).
uniform vec3 u_highlightRingColor;
uniform float u_ringWidth;
uniform float u_haloStrength;
uniform float u_haloShape; // 0 = circle, 1 = square
uniform float u_highlightScale;
uniform float u_ringStyle; // 0 = 3D torus, 1 = flat circle, 2 = flat square
uniform float u_time; // For the ring shimmer
// The pulse: 0.5 + 0.5 sin(4 t), evaluated once per draw on the CPU.
uniform float u_glow;


// Lighting uniforms (same as HP_FS_FULL)
uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_halfDir;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float rCircle = length(coord);
  float rSquare = max(abs(coord.x), abs(coord.y));
  float baseR = (u_ringStyle > 1.5) ? rSquare : rCircle;
  float shapeR = (u_ringStyle > 1.5) ? rSquare : mix(rCircle, rSquare, u_haloShape);

  if (shapeR > 1.0) discard;

  // === CONSTANT MULTIPLIER RING GEOMETRY ===
  // Inner radius = where the dot ends (1/highlightScale) with small gap
  // Outer radius = innerRadius * constant ring ratio
  // This ensures consistent proportions at ALL zoom levels

  // highlightRingRadii() is this geometry for a vector figure.
  const float INNER_GAP = ${zt.toFixed(2)};      // 8% gap between dot edge and ring inner edge
  const float RING_RATIO = ${Dt.toFixed(2)};     // Outer radius is 65% larger than inner radius

  // The dot occupies radius (1/u_highlightScale) in normalized sprite coords
  // Add small gap so ring doesn't touch the dot
  float innerRadius = (1.0 / u_highlightScale) * INNER_GAP;

  // Outer radius is constant multiple of inner
  float outerRadius = innerRadius * RING_RATIO;

  // Derive tube geometry from inner/outer
  float tubeRadius = (outerRadius - innerRadius) * 0.5;
  float majorRadius = innerRadius + tubeRadius;

  // Apply u_ringWidth as a scaling factor on tube thickness
  tubeRadius *= (0.5 + u_ringWidth * 0.5);
  // Recalculate outer after adjusting tube
  outerRadius = innerRadius + tubeRadius * 2.0;
  majorRadius = innerRadius + tubeRadius;

  // Clamp to ensure ring stays within sprite bounds
  if (outerRadius > 0.95) {
    float scale = 0.95 / outerRadius;
    innerRadius *= scale;
    outerRadius *= scale;
    tubeRadius *= scale;
    majorRadius = innerRadius + tubeRadius;
  }

  float radial = length(coord);
  float aa = fwidth(radial) * 1.5 + 0.003;

  // The dot radius in normalized coords (where the actual dot ends)
  float dotRadius = 1.0 / u_highlightScale;

  if (u_ringStyle < 0.5) {
    // ============================================
    // 3D TORUS RING + DOT - Full quality
    // Renders BOTH the dot and the ring around it
    // ============================================

    // Check if we're inside the DOT area (extends to innerRadius to fill gap)
    // This prevents underlying main point colors bleeding through when zoomed in close
    bool inDot = radial < innerRadius;

    // Distance from the ring's center circle
    float distFromRing = abs(radial - majorRadius);

    // Check if we're within the ring tube
    bool inRing = distFromRing <= tubeRadius + aa * 2.0;

    // Discard if outside both dot and ring (no outer glow)
    if (!inDot && !inRing) discard;

    vec3 finalColor;
    float finalAlpha;

    if (inDot) {
      // === RENDER THE DOT (including gap region up to innerRadius) ===
      // Scale coord to dot's local space, same approach as HP_FS_FULL
      // Gap region (radial > dotRadius) gets z=0 edge lighting naturally
      vec2 localCoord = coord / dotRadius;
      float localR2 = dot(localCoord, localCoord);
      float z = sqrt(max(1.0 - localR2, 0.0));
      vec3 normal = vec3(localCoord.x, -localCoord.y, z);

      // Glow factor: 0.0 = normal (matches unhighlighted cells), 1.0 = full glow
      float glowFactor = u_glow;

      // === BASE LIGHTING (exactly matches HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, u_lightDir), 0.0);
      float ambient = ${je};
      float diffuse = ${ke} * NdotL;
      float specularBase = max(dot(normal, u_halfDir), 0.0);
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase;
      float specular = specularBase * 0.3;

      // Lit color (same formula as HP_FS_FULL)
      vec3 litColor = u_highlightColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      // Extra brightness
      float extraBrightness = glowFactor * 0.3;
      // Extra specular
      float extraSpecular = glowFactor * 0.2 * specularBase;
      // Rim glow
      float rimFactor = 1.0 - z;
      float rimGlow = glowFactor * rimFactor * 0.25;
      // Subtle emission
      float emission = glowFactor * 0.1;

      vec3 dotColor = baseColor * (1.0 + extraBrightness) + vec3(extraSpecular) + u_highlightColor * (rimGlow + emission);

      finalColor = dotColor;

      // Hard edge at dot boundary - no soft fade
      finalAlpha = (radial <= dotRadius) ? v_alpha : 0.0;

    } else if (inRing) {
      // === RENDER THE RING ===
      // Calculate the "height" on the torus surface (circular cross-section)
      float tubeT = distFromRing / tubeRadius;
      float zNorm = sqrt(max(1.0 - tubeT * tubeT, 0.0));

      // Normal calculation for torus surface
      vec2 radialDir = coord / max(radial, 0.001);
      float radialSign = sign(radial - majorRadius);

      vec3 normal = normalize(vec3(
        radialDir * radialSign * tubeT,
        zNorm
      ));

      // Glow factor synced with dot (0.0 = dim, 1.0 = full glow)
      float glowFactor = u_glow;
      float shimmer = 0.5 + 0.5 * sin(u_time * 8.0 + radial * 3.14159);

      // === BASE LIGHTING (same formula as HP_FS_FULL at glowFactor=0) ===
      float NdotL = max(dot(normal, u_lightDir), 0.0);
      float ambient = ${je};
      float diffuse = ${ke} * NdotL;
      float specularBase = max(dot(normal, u_halfDir), 0.0);
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase; specularBase *= specularBase;
      specularBase *= specularBase;
      float specular = specularBase * 0.3;

      // Lit ring color (same formula as HP_FS_FULL): a black ring keeps
      // only its specular sheen.
      vec3 litColor = u_highlightRingColor * (ambient + diffuse) + vec3(specular);
      // Apply lighting strength (same as HP_FS_FULL)
      vec3 baseColor = mix(u_highlightRingColor, litColor, u_lightingStrength);

      // === GLOW ADDITIONS (only when glowFactor > 0) ===
      float facing = 1.0 - max(normal.z, 0.0);
      float fresnel = facing * facing * facing;
      vec3 warmWhite = vec3(1.0, 0.98, 0.95);

      // Extra brightness
      float extraBrightness = glowFactor * 0.4;
      // Extra specular with shimmer
      float extraSpec = glowFactor * shimmer * specularBase * 0.5;
      // Rim glow
      float rimGlow = glowFactor * fresnel * 0.4;
      // Subtle emission
      float emission = glowFactor * 0.15;

      vec3 ringColor = baseColor * (1.0 + extraBrightness) + warmWhite * extraSpec;
      ringColor = mix(ringColor, u_highlightRingColor * 1.3, rimGlow);
      ringColor += u_highlightRingColor * emission;

      // Hard edge on tube boundary - no soft fade that creates white outline
      bool withinTube = distFromRing <= tubeRadius;

      finalColor = ringColor;
      finalAlpha = withinTube ? (0.95 * v_alpha) : 0.0;
    }

    if (finalAlpha < 0.01) discard;

    // Fog thins the ring toward whatever is behind it (fog-shaders.js).
    fragColor = vec4(finalColor, v_fogOpacity * finalAlpha);
    return;
  }

  // ============================================
  // FLAT RING + DOT VARIANTS (Light/Ultralight quality)
  // Minimal cost: flat colors, no shading calculations
  // High-contrast center for popup effect
  // ============================================

  // Center highlight radius (40% of dot for visible pop)
  float centerRadius = innerRadius * 0.4;

  // CENTER - high contrast bright spot (circle or square based on mode)
  if (baseR < centerRadius) {
    // Bright center: boost highlight color
    vec3 centerColor = min(u_highlightColor * 1.4 + vec3(0.15), vec3(1.0));
    fragColor = vec4(centerColor, v_alpha);
    return;
  }

  // DOT AREA - standard highlight color
  if (baseR < innerRadius) {
    fragColor = vec4(u_highlightColor, v_alpha);
    return;
  }

  // RING AREA - flat fill in the ring color
  if (baseR <= outerRadius) {
    fragColor = vec4(u_highlightRingColor, v_alpha * 0.95);
    return;
  }

  discard;
}
`;function Xn(e,t){if(!Se(e)||e<=0)throw new RangeError("Figure-export point diameter must be a finite positive number.");if(!Se(t)||t<=0)throw new RangeError("Figure-export viewport scale must be a finite positive number.");return e*t}a(Xn,"scalePointDiameterToRaster");function wr(e){let t={modelView:new Float32Array(16),halfDir:new Float32Array(3),invCenterShade:1},r=Mt(t,e.viewMatrix,e.modelMatrix,e.lightDir,e.viewportHeight,e.fov);return{modelView:t.modelView,pointScale:r}}a(wr,"paneFrame");function Ht(e){let t=e?.sizeAttenuation;if(!Se(t)||t<0||t>1)throw new RangeError("Figure-export size attenuation must be a number from 0 to 1.");if(!Se(e.pointSizeMax)||e.pointSizeMax<=0)throw new RangeError("Figure-export point size cap must be a finite positive number.");let{modelView:r,pointScale:o}=wr(e),n={pointSize:0,pointScale:o,sizeAttenuation:t,pointSizeMax:e.pointSizeMax};return(s,l,i,c)=>(n.pointSize=c,ze(-(r[2]*s+r[6]*l+r[10]*i+r[14]),n))}a(Ht,"createViewportPointDiameter");function Ye(e,t){return e instanceof Error?e:new Error(t)}a(Ye,"asError");function ee(e,t,r){try{t()}catch(o){e.push(Ye(o,r))}}a(ee,"attemptCleanup");function Pe(e,t){throw e.length===1?e[0]:new AggregateError(e,t)}a(Pe,"throwTransactionFailure");function $t(e,t,r){let o=null;try{if(o=e.createShader(t),!o)throw new Error("Required WebGL shader allocation failed.");if(e.shaderSource(o,r),e.compileShader(o),!e.getShaderParameter(o,e.COMPILE_STATUS)){let n=e.getShaderInfoLog(o);throw new Error(`Could not compile shader:
`+n)}return o}catch(n){let s=[Ye(n,"WebGL shader creation failed with a non-Error value.")];o&&ee(s,()=>e.deleteShader(o),"WebGL shader rollback failed with a non-Error value."),Pe(s,"WebGL shader creation and rollback failed.")}}a($t,"createShader");function Ut(e,t,r,o,n){let s=null,l=null,i=null;try{if(s=$t(e,e.VERTEX_SHADER,t),l=$t(e,e.FRAGMENT_SHADER,r),i=e.createProgram(),!i)throw new Error("Could not allocate the required WebGL program.");if(e.attachShader(i,s),e.attachShader(i,l),o(i),e.linkProgram(i),!e.getProgramParameter(i,e.LINK_STATUS)){let m=e.getProgramInfoLog(i);throw new Error(`${n}:
${m}`)}let c=[],u=s;s=null,ee(c,()=>e.deleteShader(u),"WebGL vertex-shader cleanup failed with a non-Error value.");let f=l;if(l=null,ee(c,()=>e.deleteShader(f),"WebGL fragment-shader cleanup failed with a non-Error value."),c.length>0){let m=i;i=null,ee(c,()=>e.deleteProgram(m),"WebGL program rollback failed with a non-Error value."),Pe(c,"WebGL program linked but shader cleanup failed.")}let p=i;return i=null,p}catch(c){let u=[Ye(c,"WebGL program creation failed with a non-Error value.")];i&&ee(u,()=>e.deleteProgram(i),"WebGL program rollback failed with a non-Error value."),l&&ee(u,()=>e.deleteShader(l),"WebGL fragment-shader rollback failed with a non-Error value."),s&&ee(u,()=>e.deleteShader(s),"WebGL vertex-shader rollback failed with a non-Error value."),Pe(u,"WebGL program creation and rollback failed.")}}a(Ut,"createLinkedProgram");function yr(e,t){t!==null&&(e.getParameter(e.CURRENT_PROGRAM)===t&&e.useProgram(null),e.deleteProgram(t))}a(yr,"deleteProgramReleasingUse");var Bt=new WeakSet;function xr(e,t){t!=null&&(e.deleteTexture(t),Bt.add(t))}a(xr,"deleteTextureTracked");function Kn(e){return e!==null&&Bt.has(e)?null:e}a(Kn,"restorableTexture");function Jn(e,t,r){return typeof r?.delete=="function"&&r.gl===e?r.deleted!==!0:typeof e[t]=="function"?e[t](r):!0}a(Jn,"isGlObjectAlive");function ei(e,t,r){typeof r?.delete=="function"&&r.gl===e?r.delete():t==="deleteProgram"?yr(e,r):t==="deleteTexture"?xr(e,r):e[t](r)}a(ei,"deleteGlObject");function ti(e,t,r){return Ut(e,t,r,()=>{},"Could not link program")}a(ti,"createProgram");function ri(e,t,r,o,n=void 0){let s=n??e.INTERLEAVED_ATTRIBS;return Ut(e,t,r,l=>e.transformFeedbackVaryings(l,o,s),"Could not link transform feedback program")}a(ri,"createTransformFeedbackProgram");function oi(e,t){let r=new Map,o=[],n=a((i,c)=>{let u=`${i}:${c}`,f=r.get(u);if(f!==void 0)return f;if(f=e.createShader(i),!f)throw new Error("Required WebGL shader allocation failed.");return r.set(u,f),e.shaderSource(f,c),e.compileShader(f),f},"shaderOf"),s=a((i,c)=>{for(let[u,f,p]of[[e.VERTEX_SHADER,i.vs,"vertex"],[e.FRAGMENT_SHADER,i.fs,"fragment"]]){let m=r.get(`${u}:${f}`);if(!e.getShaderParameter(m,e.COMPILE_STATUS))return`Could not compile the ${i.label} ${p} shader:
${e.getShaderInfoLog(m)}`}return`Could not link the ${i.label} program:
${e.getProgramInfoLog(c)}`},"diagnose");try{for(let i of t){let c=n(e.VERTEX_SHADER,i.vs),u=n(e.FRAGMENT_SHADER,i.fs),f=e.createProgram();if(!f)throw new Error("Could not allocate the required WebGL program.");o.push(f),e.attachShader(f,c),e.attachShader(f,u),i.varyings&&e.transformFeedbackVaryings(f,i.varyings,i.bufferMode??e.INTERLEAVED_ATTRIBS),e.linkProgram(f)}t.forEach((i,c)=>{if(!e.getProgramParameter(o[c],e.LINK_STATUS))throw new Error(s(i,o[c]))})}catch(i){let c=[Ye(i,"WebGL program batch failed with a non-Error value.")];for(let u of o)ee(c,()=>e.deleteProgram(u),"WebGL program rollback failed with a non-Error value.");for(let u of r.values())ee(c,()=>e.deleteShader(u),"WebGL shader rollback failed with a non-Error value.");Pe(c,"WebGL program batch creation and rollback failed.")}let l=[];for(let i of r.values())ee(l,()=>e.deleteShader(i),"WebGL shader cleanup failed with a non-Error value.");if(l.length>0){for(let i of o)ee(l,()=>e.deleteProgram(i),"WebGL program rollback failed with a non-Error value.");Pe(l,"WebGL programs linked but shader cleanup failed.")}return o}a(oi,"createProgramBatch");function ni(e){e.enable(e.BLEND),e.blendEquation(e.FUNC_ADD),e.blendFuncSeparate(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA,e.ONE,e.ONE_MINUS_SRC_ALPHA)}a(ni,"configureStraightAlphaBlending");function ii(e,t){return e.clientWaitSync(t,e.SYNC_FLUSH_COMMANDS_BIT,0)!==e.TIMEOUT_EXPIRED}a(ii,"fenceHasPassed");var Gt=16777216;function ai(e,t,r){let o=0;for(let n=0;n<r;n+=Gt)e.drawArrays(e.POINTS,t+n,Math.min(Gt,r-n)),o++;return o}a(ai,"drawPointsInSegments");function li(e,t,r){if(!r)throw new TypeError("A vertex attribute is released onto a buffer the vertex array may keep, never onto none.");e.bindBuffer(e.ARRAY_BUFFER,r),e.vertexAttribPointer(t,1,e.UNSIGNED_BYTE,!1,0,0),e.disableVertexAttribArray(t),e.bindBuffer(e.ARRAY_BUFFER,null)}a(li,"releaseVertexAttribute");var vr=typeof ResizeObserverEntry=="function"&&"devicePixelContentBoxSize"in ResizeObserverEntry.prototype;function ut(e,t){let r=e.getBoundingClientRect();return{width:Math.max(0,Math.round(r.right*t)-Math.round(r.left*t)),height:Math.max(0,Math.round(r.bottom*t)-Math.round(r.top*t))}}a(ut,"snappedDevicePixelSize");function si(e,t=null){let r=window.devicePixelRatio||1,o=e.clientWidth,n=e.clientHeight,s=ut(e,r),l=s.width,i=s.height,c=Object.freeze({get cssHeight(){return n},get cssWidth(){return o},get height(){return i},get width(){return l}}),u=null,f=null,p=new Set,m=!0,d=a(()=>{r=window.devicePixelRatio||1;let _=ut(e,r);l=_.width,i=_.height,t?.()},"updateDimensions"),h=a(_=>{if(!m)return;let x=_[0];r=window.devicePixelRatio||1,o=x.contentRect.width,n=x.contentRect.height;let A=ut(e,r);l=A.width,i=A.height,t?.()},"handleResize"),g=a(_=>{_.mediaQuery.removeEventListener("change",_.handler),p.delete(_)},"retireDprRegistration"),w=a(()=>{if(!m)return;let _=window.devicePixelRatio||1,x={handler:null,mediaQuery:window.matchMedia(`(resolution: ${_}dppx)`)};x.handler=()=>{!m||f!==x||(d(),w())},p.add(x);try{x.mediaQuery.addEventListener("change",x.handler)}catch(A){try{g(x)}catch(q){throw new AggregateError([A,q],"Canvas DPR-listener setup and rollback both failed.")}throw A}f=x;for(let A of p)if(A!==x)try{g(A)}catch{}},"armDprMonitor"),y=a(()=>{m=!1,f=null;let _=[];if(u!==null)try{u.disconnect(),u=null}catch(x){_.push(x)}for(let x of p)try{g(x)}catch(A){_.push(A)}if(_.length>0)throw new AggregateError(_,`Canvas resize subscription retains ${_.length} pending cleanup failure(s).`)},"disconnectResizeSources");try{u=new ResizeObserver(h),u.observe(e,vr?{box:"device-pixel-content-box"}:void 0),w()}catch(_){let x=[];try{y()}catch(A){x.push(A)}throw x.length>0?new AggregateError([_,...x],"Canvas resize-observer construction and rollback both failed."):_}return{getSize(){return(e.width!==l||e.height!==i)&&(e.width=l,e.height=i),c},disconnect(){y()}}}a(si,"createCanvasResizeObserver");function ci(e,t=3){if(t!==1&&t!==2&&t!==3)throw new RangeError("normalizePositions dimension must be exactly 1, 2, or 3.");if(!e||e.length===0)return{center:[0,0,0],scale:1};if(e.length%t!==0)throw new RangeError(`normalizePositions received ${R(e.length,"value")}, which is not a whole number of ${t}-component points.`);let r=[1/0,1/0,1/0],o=[-1/0,-1/0,-1/0];for(let d=0;d<t;d++){let h=1/0,g=-1/0;for(let w=d;w<e.length;w+=t){let y=e[w];y<h&&(h=y),y>g&&(g=y)}r[d]=h,o[d]=g}for(let d=t;d<3;d++)r[d]=0,o[d]=0;let n=.5*(r[0]+o[0]),s=.5*(r[1]+o[1]),l=.5*(r[2]+o[2]),i=[n,s,l],c=o[0]-r[0],u=o[1]-r[1],f=o[2]-r[2],p=Math.max(c,u,f);p===0&&(p=1);let m=2/p;for(let d=0;d<t;d++){let h=i[d];for(let g=d;g<e.length;g+=t)e[g]=(e[g]-h)*m}return{center:i,scale:m}}a(ci,"normalizePositions");var br=Object.freeze(ct.map(e=>Math.round(e*255))),Sr=`rgb(${br.join(", ")})`;function Er({pageName:e,cellCount:t}){if(!Number.isSafeInteger(t)||t<=0)return null;let r=String(e??"").trim(),o=R(t,"cell");return{label:r===""?`Highlighted (${o})`:`Highlighted: ${r} (${o})`,color:Sr}}a(Er,"highlightLegendEntry");function gi({selection:e,views:t}){let r=Er({pageName:e.pageName,cellCount:e.totalCount});if(r===null)return null;let o=t.map(n=>Ct({highlightArray:e.highlightArray,transparency:n.data?.transparency??null,lodMembership:n.scientificState.lodMembership??null})>0);return o.some(Boolean)?{entry:r,panels:o}:null}a(gi,"figureHighlightLegend");function Si({positions:e,dimension:t,colors:r,colorAlpha:o,transparency:n=null,renderState:s,plotRect:l,pointDiameterViewportPx:i,lodMembership:c=null,drawOrder:u=null,crop:f=null,sortByDepth:p=!1,depthBins:m=256,pointLayers:d=null,onPoint:h}){let g=xt(o,"Figure-export projected colors")==="opacity",w=g?null:tt(d,"Figure-export projected point layers"),y=w===null?null:w.unreadColor.map(S=>Math.round(S*255)),_=w===null?null:w.zeroColor.map(S=>Math.round(S*255));if(!(typeof i=="number"&&Number.isFinite(i)&&i>0))throw new RangeError("Figure-export point diameter must be a finite positive number.");let x=i*(w===null?1:w.readScale),A=a(S=>w!==null&&r[S*4+3]===H,"isUnread"),q=a(S=>_!==null&&r[S*4+3]===fe,"isZero");if(!e||!r||!s?.mvpMatrix)return{drawn:0,skipped:0};let G=a(S=>n?n[S]??1:g?r[S*4+3]/255:1,"opacityOf"),te=ve(e,t,"Figure-export projected positions",{allowEmpty:!0}),X=Math.min(te,Math.floor(r.length/4));$e(c,{pointCount:te}),et(u,{pointCount:te});let M=Tt(c,u,g?null:r,w?.readEveryLevel===!0),U=M?.length??X,B=s.mvpMatrix,{source:z,viewportToPlot:me}=Lt({renderState:s,plotRect:l,crop:f}),K=me(z.x,z.y),re=K.x,L=K.y,oe=l.width/z.width,_e=l.height/z.height,O=new Float64Array(3),be=Ht(s),se=a((S,v,P,b)=>be(S,v,P,b)*oe*.5,"radiusAt"),T=0,F=X-U,N=[0,0],j=[0,0,0],he=a(S=>{let v=G(S),P=Number.isFinite(v)?v:1;if(P<0?P=0:P>1&&(P=1),P<$)return 0;let b=S*t,k=e[b],V=t>1?e[b+1]:0,Z=t>2?e[b+2]:0;return ye(B,z,k,V,Z,O)?(N[0]=re+O[0]*oe,N[1]=L+O[1]*_e,j[0]=k,j[1]=V,j[2]=Z,P):0},"project");if(p){let S=0;if(w!==null)for(let E=0;E<U;E++){let I=M===null?E:M[E];if(!A(I))break;let ne=he(I);ne!==0&&(h(N[0],N[1],y[0],y[1],y[2],ne,se(j[0],j[1],j[2],i),I),S++)}let v=m|0;v<16?v=16:v>1024&&(v=1024);let P=new Uint32Array(v),b=0;for(let E=0;E<U;E++){let I=M===null?E:M[E];if(A(I))continue;let ne=G(I),C=Number.isFinite(ne)?ne:1;if(C<0?C=0:C>1&&(C=1),C<$)continue;let ie=I*t,de=e[ie],Re=t>1?e[ie+1]:0,Ie=t>2?e[ie+2]:0;if(!ye(B,z,de,Re,Ie,O))continue;let Q=(O[2]+1)*.5*v|0;Q<0?Q=0:Q>=v&&(Q=v-1),P[Q]++,b++}if(b===0)return{drawn:S,skipped:X-S};let k=new Uint32Array(v),V=0;for(let E=0;E<v;E++)k[E]=V,V+=P[E],P[E]=0;let Z=new Float32Array(b),ce=new Float32Array(b),Y=new Uint8Array(b*4),W=new Float32Array(b),ue=new Float32Array(b),we=new Uint32Array(b);for(let E=0;E<U;E++){let I=M===null?E:M[E];if(A(I))continue;let ne=G(I),C=Number.isFinite(ne)?ne:1;if(C<0?C=0:C>1&&(C=1),C<$)continue;let ie=I*t,de=e[ie],Re=t>1?e[ie+1]:0,Ie=t>2?e[ie+2]:0;if(!ye(B,z,de,Re,Ie,O))continue;let Q=(O[2]+1)*.5*v|0;Q<0?Q=0:Q>=v&&(Q=v-1);let xe=k[Q]+P[Q]++;Z[xe]=re+O[0]*oe,ce[xe]=L+O[1]*_e;let Ce=I*4,Ne=xe*4,We=q(I);Y[Ne]=We?_[0]:r[Ce],Y[Ne+1]=We?_[1]:r[Ce+1],Y[Ne+2]=We?_[2]:r[Ce+2],Y[Ne+3]=r[Ce+3],W[xe]=C,ue[xe]=se(de,Re,Ie,x),we[xe]=I}for(let E=v-1;E>=0;E--){let I=k[E],ne=I+P[E];for(let C=I;C<ne;C++){let ie=W[C];if(ie<$)continue;let de=C*4;h(Z[C],ce[C],Y[de],Y[de+1],Y[de+2],ie,ue[C],we[C]),T++}}return T+=S,F=Math.max(0,X-T),{drawn:T,skipped:F}}for(let S=0;S<U;S++){let v=M===null?S:M[S],P=G(v),b=Number.isFinite(P)?P:1;if(b<0?b=0:b>1&&(b=1),b<$){F++;continue}let k=v*t,V=e[k],Z=t>1?e[k+1]:0,ce=t>2?e[k+2]:0;if(!ye(B,z,V,Z,ce,O)){F++;continue}let Y=re+O[0]*oe,W=L+O[1]*_e,ue=v*4;A(v)?h(Y,W,y[0],y[1],y[2],b,se(V,Z,ce,i),v):q(v)?h(Y,W,_[0],_[1],_[2],b,se(V,Z,ce,x),v):h(Y,W,r[ue],r[ue+1],r[ue+2],b,se(V,Z,ce,x),v),T++}return{drawn:T,skipped:F}}a(Si,"forEachProjectedPoint");export{at as a,hr as b,un as c,fn as d,lt as e,gn as f,mn as g,_n as h,wn as i,yn as j,xn as k,Be as l,Io as m,Co as n,Pt as o,No as p,sr as q,Oo as r,Fo as s,Mo as t,yr as u,xr as v,Kn as w,Jn as x,ei as y,ti as z,ri as A,oi as B,ni as C,ii as D,Gt as E,ai as F,li as G,si as H,ci as I,Te as J,fe as K,H as L,xt as M,Ve as N,$ as O,kr as P,Jt as Q,Ee as R,Ar as S,Tr as T,Lr as U,pt as V,yt as W,Yt as X,Wt as Y,Nr as Z,qt as _,Or as $,Fr as aa,Mr as ba,_t as ca,Ae as da,zr as ea,Dr as fa,Me as ga,Vt as ha,Gr as ia,De as ja,Ln as ka,Ot as la,Pn as ma,Rn as na,In as oa,Cn as pa,Nn as qa,On as ra,Fn as sa,Mn as ta,zn as ua,Mt as va,Dn as wa,ct as xa,_r as ya,Hn as za,$n as Aa,Gn as Ba,Un as Ca,Bn as Da,qr as Ea,Jr as Fa,He as Ga,Je as Ha,io as Ia,ao as Ja,lo as Ka,so as La,ve as Ma,Go as Na,Uo as Oa,Bo as Pa,jo as Qa,ko as Ra,Yo as Sa,$e as Ta,mo as Ua,_o as Va,et as Wa,Tt as Xa,tt as Ya,wo as Za,Ge as _a,So as $a,Eo as ab,Lt as bb,ye as cb,Ao as db,To as eb,Qo as fb,Ko as gb,Ct as hb,nn as ib,an as jb,ln as kb,br as lb,Er as mb,gi as nb,Xn as ob,Ht as pb,Si as qb};
