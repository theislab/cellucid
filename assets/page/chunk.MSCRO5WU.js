import{D as ge,U as nt,V as ke,a as Ce,da as Pe,la as Te,ma as Le,pa as Ve,r as ot,t as rt,v as it,y as Be}from"./chunk.T3PFD7EH.js";import{b as at}from"./chunk.4YBQPTUJ.js";import{a as tt,b as ie}from"./chunk.TQZ3TQFW.js";import{a as m}from"./chunk.2SQHPJQN.js";function mt(e,t,r){if(!Number.isFinite(e)||!Number.isFinite(t))throw new TypeError("Figure-export coordinates must be finite numbers.");if(r===null||typeof r!="object"||Array.isArray(r)||Object.getPrototypeOf(r)!==Object.prototype||Object.keys(r).sort().join(",")!=="center,scale"||!Array.isArray(r.center)||r.center.length!==3||r.center.some(a=>!Number.isFinite(a))||!Number.isFinite(r.scale)||r.scale<=0)throw new TypeError("Figure-export normalization transform must contain exact finite center and positive scale values.");let{scale:o,center:i}=r;return{x:e/o+i[0],y:t/o+i[1]}}m(mt,"denormalizeXY");function Et({positions:e,dimension:t,transparency:r=null,lodMembership:o=null,mvpMatrix:i,viewportWidth:a=1,viewportHeight:s=1,crop:n=null,normTransform:d}){if(!e||!i)return null;let h=Pe(e,t,"Figure-export positions",{allowEmpty:!0});Ve(o,{pointCount:h});let g=o?.indices??null,_=g?.length??h,u=i,f=Math.max(1,Number(a)||1),l=Math.max(1,Number(s)||1),y=Te(n),x=Le(y,f,l),w=!!(x&&(x.width<f-.5||x.height<l-.5||x.x>.5||x.y>.5)),b=1/0,S=-1/0,T=1/0,oe=-1/0,O=!1;for(let V=0;V<_;V++){let c=g===null?V:g[V],_e=r?r[c]??1:1,p=Number.isFinite(_e)?_e:1;if(p<0?p=0:p>1&&(p=1),p<ge)continue;let H=c*t,F=e[H],P=t>1?e[H+1]:0,A=t>2?e[H+2]:0,I=u[0]*F+u[4]*P+u[8]*A+u[12],q=u[1]*F+u[5]*P+u[9]*A+u[13],de=u[2]*F+u[6]*P+u[10]*A+u[14],Z=u[3]*F+u[7]*P+u[11]*A+u[15];if(!Number.isFinite(Z)||Z<=0)continue;let G=I/Z,J=q/Z,Q=de/Z;if(G<-1||G>1||J<-1||J>1||Q<-1||Q>1)continue;if(w&&x){let Y=(G*.5+.5)*f,$=(-J*.5+.5)*l;if(Y<x.x||Y>x.x+x.width||$<x.y||$>x.y+x.height)continue}let C=mt(F,P,d);!Number.isFinite(C.x)||!Number.isFinite(C.y)||(C.x<b&&(b=C.x),C.x>S&&(S=C.x),C.y<T&&(T=C.y),C.y>oe&&(oe=C.y),O=!0)}return O?{minX:b,maxX:S,minY:T,maxY:oe}:null}m(Et,"computeVisibleRealBounds");function Pt({positions:e,dimension:t,transparency:r=null,lodMembership:o=null,mvpMatrix:i,viewMatrix:a,viewportWidth:s=1,viewportHeight:n=1,crop:d=null}){if(!e||!i||!a)return null;let h=Pe(e,t,"Figure-export positions",{allowEmpty:!0});Ve(o,{pointCount:h});let g=o?.indices??null,_=g?.length??h,u=i,f=a,l=Math.max(1,Number(s)||1),y=Math.max(1,Number(n)||1),x=Te(d),w=Le(x,l,y),b=!!(w&&(w.width<l-.5||w.height<y-.5||w.x>.5||w.y>.5)),S=1/0,T=-1/0,oe=1/0,O=-1/0,V=!1;for(let c=0;c<_;c++){let _e=g===null?c:g[c],p=r?r[_e]??1:1,H=Number.isFinite(p)?p:1;if(H<0?H=0:H>1&&(H=1),H<ge)continue;let F=_e*t,P=e[F],A=t>1?e[F+1]:0,I=t>2?e[F+2]:0,q=u[0]*P+u[4]*A+u[8]*I+u[12],de=u[1]*P+u[5]*A+u[9]*I+u[13],Z=u[2]*P+u[6]*A+u[10]*I+u[14],G=u[3]*P+u[7]*A+u[11]*I+u[15];if(!Number.isFinite(G)||G<=0)continue;let J=q/G,Q=de/G,C=Z/G;if(J<-1||J>1||Q<-1||Q>1||C<-1||C>1)continue;if(b&&w){let ce=(J*.5+.5)*l,se=(-Q*.5+.5)*y;if(ce<w.x||ce>w.x+w.width||se<w.y||se>w.y+w.height)continue}let Y=f[0]*P+f[4]*A+f[8]*I+f[12],$=f[1]*P+f[5]*A+f[9]*I+f[13];!Number.isFinite(Y)||!Number.isFinite($)||(Y<S&&(S=Y),Y>T&&(T=Y),$<oe&&(oe=$),$>O&&(O=$),V=!0)}return V?{minX:S,maxX:T,minY:oe,maxY:O}:null}m(Pt,"computeVisibleCameraBounds");var Xe=`
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
`;function _t(e,t,r){let o=Math.max(r-t,1e-4);return e*e*.6*Math.LOG2E/o}m(_t,"fogScale");function Ft(e,t,r,o,i,a){t!==null&&e.uniform1f(t,i),r!==null&&e.uniform1f(r,_t(o,i,a))}m(Ft,"writeFogUniforms");function It(e){return e*(.1+.9*e)}m(It,"fogOpacityAt");var We=`
// The texel of item \`index\` in a linear texture (rendering/linear-texture.js):
// shape.x = log2(width), shape.y = rows per layer. (\`layout\` is a GLSL
// keyword, which Firefox's compiler rejects as a name.)
ivec3 linearTexel(int index, ivec2 shape) {
  int row = index >> shape.x;
  int layer = row / shape.y;
  return ivec3(index & ((1 << shape.x) - 1), row - layer * shape.y, layer);
}
`;function st(e){return 31-Math.clz32(e)}m(st,"floorLog2");function xt(e,t,r){if(!Number.isSafeInteger(e)||e<0)throw new RangeError(`Linear texture item count must be a non-negative safe integer, not ${e}.`);if(!Number.isSafeInteger(t)||t<=0)throw new RangeError("Linear texture needs a positive MAX_TEXTURE_SIZE.");if(!Number.isSafeInteger(r)||r<=0)throw new RangeError("Linear texture needs a positive MAX_ARRAY_TEXTURE_LAYERS.");let o=Math.max(1,e),i=st(t),a=o<=1?0:st(o-1)+1,s=Math.min(i,a),n=Math.ceil(o/2**s),d=n===1?o:2**s,h=Math.ceil(n/t);if(h>r)throw new RangeError(`${ie(e,"item")} need ${h} texture layers; this GPU allows ${r}.`);let g=Math.ceil(n/h);if(o>2**31-1)throw new RangeError(`${ie(e,"item")} exceed the shader's integer index range.`);return Object.freeze({itemCount:e,width:d,widthShift:s,rowsPerLayer:g,layers:h,rows:n,texels:d*g*h})}m(xt,"planLinearTexture");function Dt(e,t){if(!Number.isSafeInteger(t)||t<0||t>e.texels)throw new RangeError(`A linear texture of ${ie(e.texels,"texel")} cannot hold ${Number.isSafeInteger(t)?ie(t,"item"):String(t)}.`);return Object.freeze({...e,itemCount:t,rows:Math.ceil(Math.max(1,t)/e.width)})}m(Dt,"resizedLinearPlan");function zt(e,t){return xt(t,e.getParameter(e.MAX_TEXTURE_SIZE),e.getParameter(e.MAX_ARRAY_TEXTURE_LAYERS))}m(zt,"planLinearTextureFor");function Mt(e,t,r){let o=e.TEXTURE_2D_ARRAY;e.texParameteri(o,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(o,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(o,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(o,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texStorage3D(o,1,t,r.width,r.rowsPerLayer,r.layers)}m(Mt,"allocateLinearTexture");function Ut(e,t,r,o,i,a,s=0,n=t.rows){let d=t.itemCount,h=t.width,g=Math.min(n,Math.ceil(d/h)),_=i.length>=g*h*a?g:Math.floor(d/h),u=0,f=Math.max(0,s);for(;f<g;){let l=Math.floor(f/t.rowsPerLayer),y=Math.min(g,(l+1)*t.rowsPerLayer),x=f-l*t.rowsPerLayer,w=Math.min(y,_);if(f<w){let oe=f*h*a,O=w*h*a;e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,x,l,h,w-f,1,r,o,i,oe),u+=(O-oe)*i.BYTES_PER_ELEMENT,f=w;continue}let b=d-f*h,S=f*h*a,T=S+b*a;e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,x,l,b,1,1,r,o,i,S),u+=(T-S)*i.BYTES_PER_ELEMENT,f+=1}return u}m(Ut,"writeLinearTextureRows");function Ot(e,t,r,o,i,a,s,n,d=0){if(!(Number.isSafeInteger(s)&&Number.isSafeInteger(n)&&s>=0&&n>=s&&n<=t.itemCount))throw new RangeError(`Linear texture items [${s}, ${n}) are outside its ${t.itemCount}.`);if(!(Number.isSafeInteger(d)&&d>=0&&d<=s&&(n-d)*a<=i.length))throw new RangeError(`Linear texture items [${s}, ${n}) are not all in data holding items from ${d}.`);let h=t.width,g=0,_=s,u=m((f,l)=>{let y=Math.floor(f/h),x=Math.floor(y/t.rowsPerLayer);e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,f-y*h,y-x*t.rowsPerLayer,x,l,1,1,r,o,i,(f-d)*a),g+=l*a*i.BYTES_PER_ELEMENT},"writeRun");if(_%h!==0&&_<n){let f=Math.min(n,(Math.floor(_/h)+1)*h)-_;u(_,f),_+=f}for(;n-_>=h;){let f=_/h,l=Math.floor(f/t.rowsPerLayer),y=Math.min(Math.floor((n-_)/h),(l+1)*t.rowsPerLayer-f);e.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,f-l*t.rowsPerLayer,l,h,y,1,r,o,i,(_-d)*a),g+=y*h*a*i.BYTES_PER_ELEMENT,_+=y*h}return _<n&&u(_,n-_),g}m(Ot,"writeLinearTextureItems");function Ht(e,t,r){t!==null&&e.uniform2i(t,r.widthShift,r.rowsPerLayer)}m(Ht,"setLinearLayoutUniform");var Vt=2,lt=Object.freeze({ambient:.5,diffuse:.5}),Ne=lt.ambient.toFixed(2),De=lt.diffuse.toFixed(2),Xt=`#version 300 es
precision highp float;

// Two vertex streams: position (float32, 1-3 components; missing axes read as 0)
// and color.rgba (uint8 normalized)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
// The largest sprite this pass may draw, in the pixels it is drawing into.
// A figure export rasterises the same scene at a multiple of the screen
// size, so a fixed cap would clamp a point at a different fraction of the
// image than it occupies on screen, and the exported figure would stop
// being the view it claims to reproduce. Zero means unset, and the floor
// below keeps that behaving exactly as the fixed cap did.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth:
// viewportHeight / (2 tan(fov / 2)) * 0.01.
uniform float u_pointScale;

${Xe}
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
// Which cells this pass draws, by the layer their colour's alpha byte names
// (alpha-visibility.js): 0 every one; 1 the grey beneath the coloured cells
// (BENEATH_ALPHA_BYTE, 254); 2 the coloured cells (255); 3 the cells not read
// (UNREAD_ALPHA_BYTE, 253). A field with lower layers is drawn a layer a
// pass, bottom first (3, 1, 2), so each lies over the one before in 2-D
// blending and wins depth ties in 3-D, at every level of detail and culled
// range.
uniform int u_drawPass;
// The colour of a cell not read: the background's, faded toward the grey
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
${We}
${Ce}

flat out vec3 v_color;
flat out float v_alpha;
flat out float v_radiusPx;
// Fog transmittance (1 is unfogged), and the opacity it leaves a translucent
// point (fog-shaders.js). Full thins the point by the opacity; Sculpted is
// opaque and mixes its colour by the transmittance.
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

  // Perspective point size with attenuation
  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  gl_PointSize = clamp(gl_PointSize, 0.5, max(u_pointSizeMax, 128.0));

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

  // The passes of the lower layers draw them in their own colours (a
  // figure's raster bakes those into the colours and draws in pass 0).
  v_color = u_drawPass == 3 ? u_unreadColor : (u_drawPass == 1 ? u_zeroColor : a_color.rgb);
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`,Wt=`#version 300 es
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
  // disc. Two separate discards, the first ahead of everything else, cost 12 %
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
  vec3 litColor = v_color * (${Ne} + ${De} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = vec4(shadedColor, v_alpha * v_fogOpacity);
}
`,qt=`#version 300 es
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
  vec3 litColor = v_color * (${Ne} + ${De} * NdotL) + vec3(specular * 0.3);
  vec3 shadedColor = mix(v_color, litColor, u_lightingStrength);

  // Fog thins the point toward whatever is behind it (fog-shaders.js).
  fragColor = covered ? vec4(shadedColor, v_alpha * v_fogOpacity * coverage) : vec4(0.0);
}
`,Zt=`#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed, auto-normalized by WebGL

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
// The largest sprite this pass may draw, in the pixels it is drawing into.
// A figure export rasterises the same scene at a multiple of the screen
// size, so a fixed cap would clamp a point at a different fraction of the
// image than it occupies on screen, and the exported figure would stop
// being the view it claims to reproduce. Zero means unset, and the floor
// below keeps that behaving exactly as the fixed cap did.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth; see HP_VS_FULL.
uniform float u_pointScale;

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
// Which cells this pass draws, by the layer their colour's alpha byte names
// (alpha-visibility.js): 0 every one; 1 the grey beneath the coloured cells
// (BENEATH_ALPHA_BYTE, 254); 2 the coloured cells (255); 3 the cells not read
// (UNREAD_ALPHA_BYTE, 253). A field with lower layers is drawn a layer a
// pass, bottom first (3, 1, 2), so each lies over the one before in 2-D
// blending and wins depth ties in 3-D, at every level of detail and culled
// range.
uniform int u_drawPass;
// The colour of a cell not read: the background's, faded toward the grey
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
${We}
${Ce}

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

  float perspectiveSize = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  gl_PointSize = mix(u_pointSize, perspectiveSize, u_sizeAttenuation);
  // Identical bounds to HP_VS_FULL, and to the copy HP_VS_HIGHLIGHT keeps of
  // this formula. Shader quality selects shading, never geometry: a higher
  // ceiling here made "light" and "ultralight" draw larger points than "full"
  // at close range, which is both a different picture and — because point area
  // is quadratic in the size — more fill. The old 192.0 measured 1.23x the GPU
  // frame time of this at point size 40 and 1.90x at 60, so the two faster
  // shaders were the slower ones exactly where speed is wanted.
  gl_PointSize = clamp(gl_PointSize, 0.5, max(u_pointSizeMax, 128.0));

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

  // The passes of the lower layers draw them in their own colours (a
  // figure's raster bakes those into the colours and draws in pass 0).
  v_color = u_drawPass == 3 ? u_unreadColor : (u_drawPass == 1 ? u_zeroColor : a_color.rgb);
  v_alpha = alpha;
  // Sprite radius in pixels, for the antialiased rim of the no-depth fragment
  // shaders (see HP_FS_FULL_NO_DEPTH).
  v_radiusPx = 0.5 * gl_PointSize;
}
`,Jt=`#version 300 es
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
`,Qt=`#version 300 es
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
`,Kt=`#version 300 es
precision mediump float;

flat in vec3 v_color;
flat in float v_alpha;
flat in float v_radiusPx;

out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, v_alpha);
}
`,W=Object.freeze({skyAmbient:1,groundAmbient:.5,ambientWeight:.25,wrap:.25,diffuseWeight:1,edgeOcclusion:.22,sheenWeight:.45}),me=m(e=>{let t=String(e);return t.includes(".")||t.includes("e")?t:`${t}.0`},"GLSL_FLOAT"),ct=`
// Pixels per unit of (1 - r^2) / 2 across the disc rim; see
// HP_FS_FULL_NO_DEPTH.
float rimSharpness(float radiusPx) {
  return 0.5 * max(radiusPx, 8.0 - radiusPx);
}

// Sculpted lighting of one sphere normal, in linear light, before the
// centre normalisation. Mirrors sculptedCenterShade() in JavaScript.
float sculptedShade(vec3 normal, out float sky) {
  sky = normal.y * 0.5 + 0.5;
  float ambient = mix(${me(W.groundAmbient)}, ${me(W.skyAmbient)}, sky);
  float wrapped = clamp(
    (dot(normal, u_lightDir) + ${me(W.wrap)}) * ${me(1/(1+W.wrap))},
    0.0,
    1.0
  );
  float occlusion = mix(${me(W.edgeOcclusion)}, 1.0, smoothstep(0.0, 0.75, normal.z));
  return (
    ${me(W.ambientWeight)} * ambient +
    ${me(W.diffuseWeight)} * wrapped * wrapped
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
    + (${me(W.sheenWeight)} * gloss) * mix(vec3(1.0), albedo, 0.25);
  vec3 shaded = sqrt(lit);
  return mix(u_fogColor, mix(v_color, shaded, u_lightingStrength), v_fogT);
}
`,eo=`#version 300 es
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
${ct}
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
`,to=`#version 300 es
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
${ct}
void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  float coverage = clamp((1.0 - r2) * rimSharpness(v_radiusPx) + 0.5, 0.0, 1.0);
  bool covered = v_alpha >= 0.01 && coverage > 0.0;
  fragColor = covered ? vec4(sculptedColor(coord, r2), v_alpha * coverage) : vec4(0.0);
}
`;function wt(e){let r=W.groundAmbient+(W.skyAmbient-W.groundAmbient)*.5,o=Math.min(1,Math.max(0,(e[2]+W.wrap)/(1+W.wrap)));return W.ambientWeight*r+W.diffuseWeight*o*o}m(wt,"sculptedCenterShade");var yt=1e-6;function oo(e,t,r,o,i,a){let s=e.modelView,n=t,d=r;for(let l=0;l<4;l++){let y=d[l*4],x=d[l*4+1],w=d[l*4+2],b=d[l*4+3];s[l*4]=n[0]*y+n[4]*x+n[8]*w+n[12]*b,s[l*4+1]=n[1]*y+n[5]*x+n[9]*w+n[13]*b,s[l*4+2]=n[2]*y+n[6]*x+n[10]*w+n[14]*b,s[l*4+3]=n[3]*y+n[7]*x+n[11]*w+n[15]*b}let h=o[0],g=o[1],_=o[2]+1,u=Math.hypot(h,g,_),f=e.halfDir;return u>0?(f[0]=h/u,f[1]=g/u,f[2]=_/u):(f[0]=0,f[1]=0,f[2]=1),e.invCenterShade=1/wt(o),i/Math.max(2*Math.tan(a*.5),yt)*.01}m(oo,"writePointShaderFrame");var ro=Object.freeze({full:Object.freeze({scale:1.75,ringWidth:.42,haloStrength:.65,haloShape:0,ringStyle:0,animated:!0}),sculpted:Object.freeze({scale:1.75,ringWidth:.42,haloStrength:.65,haloShape:0,ringStyle:0,animated:!1}),light:Object.freeze({scale:1.7,ringWidth:.44,haloStrength:.6,haloShape:0,ringStyle:1,animated:!1}),ultralight:Object.freeze({scale:1.65,ringWidth:.46,haloStrength:.55,haloShape:.35,ringStyle:2,animated:!1})});function io(e){return .5+.5*Math.sin(e*4)}m(io,"highlightGlowAt");var no=`#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed - we only use alpha for visibility

uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform float u_pointSize;
// The largest sprite this pass may draw, in the pixels it is drawing into.
// A figure export rasterises the same scene at a multiple of the screen
// size, so a fixed cap would clamp a point at a different fraction of the
// image than it occupies on screen, and the exported figure would stop
// being the view it claims to reproduce. Zero means unset, and the floor
// below keeps that behaving exactly as the fixed cap did.
uniform float u_pointSizeMax;
uniform float u_sizeAttenuation;
// Pixels per world unit of point size at unit eye depth; see HP_VS_FULL.
uniform float u_pointScale;
uniform float u_highlightScale; // How much larger the highlight ring is (e.g., 1.5)

${Xe}
${Ce}
flat out float v_alpha;
flat out float v_fogOpacity; // The opacity fog leaves this ring (fog-shaders.js)

void main() {
  vec4 eyePos = u_modelViewMatrix * vec4(a_position, 1.0);
  gl_Position = u_projectionMatrix * eyePos;

  float eyeDepth = -eyePos.z;

  // Calculate what the DOT size would be (same formula as main dot shader)
  float dotPerspective = (u_pointSize * u_pointScale) / max(eyeDepth, 0.001);
  float dotSize = mix(u_pointSize, dotPerspective, u_sizeAttenuation);
  dotSize = clamp(dotSize, 0.5, max(u_pointSizeMax, 128.0)); // Same clamp as main dots!

  // Highlight sprite scales proportionally with dot using constant multiplier
  // This ensures consistent visual appearance at all zoom levels
  float highlightSize = dotSize * u_highlightScale;
  highlightSize = clamp(highlightSize, 1.0, 256.0);
  gl_PointSize = highlightSize;

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
`,ao=`#version 300 es
precision highp float;

flat in float v_alpha;
flat in float v_fogOpacity; // The opacity fog leaves this ring (HP_VS_HIGHLIGHT)

uniform vec3 u_highlightColor;
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

  const float INNER_GAP = 1.08;      // 8% gap between dot edge and ring inner edge
  const float RING_RATIO = 1.65;     // Outer radius is 55% larger than inner radius

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
      float ambient = ${Ne};
      float diffuse = ${De} * NdotL;
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
      float ambient = ${Ne};
      float diffuse = ${De} * NdotL;
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
      ringColor = mix(ringColor, u_highlightColor * 1.3, rimGlow);
      ringColor += u_highlightColor * emission;

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

  // RING AREA - flat fill, slightly darker than dot
  if (baseR <= outerRadius) {
    fragColor = vec4(u_highlightColor * 0.75, v_alpha * 0.95);
    return;
  }

  discard;
}
`;function uo(e,t){e.enable(e.BLEND),e.blendEquation(e.FUNC_ADD),e.blendFuncSeparate(e.ONE,e.ZERO,e.ONE,e.ONE_MINUS_SRC_ALPHA),t?e.enable(e.SAMPLE_ALPHA_TO_COVERAGE):e.disable(e.SAMPLE_ALPHA_TO_COVERAGE)}m(uo,"enterOpaquePointBlending");function ho(e,t,r=!1){let o=null;if(r)try{e.disable(e.SAMPLE_ALPHA_TO_COVERAGE),ot(e)}catch(i){o=[i]}if(t)try{e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,null)}catch(i){o=[i]}try{e.bindVertexArray(null)}catch(i){o===null?o=[i]:o.push(i)}try{e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D_ARRAY,null)}catch(i){o===null?o=[i]:o.push(i)}try{e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D_ARRAY,null)}catch(i){o===null?o=[i]:o.push(i)}if(o!==null)throw o.length===1?o[0]:new AggregateError(o,"HighPerfRenderer point-draw baseline restoration failed.")}m(ho,"restorePointDrawBaseline");function fo(e,t,r){if(e!==null){if(t!==null){let o=t instanceof AggregateError?t.errors:null;throw new AggregateError(o===null?[e,t]:[e,...o],`${r} and baseline restoration both failed.`)}throw e}if(t!==null)throw t}m(fo,"settlePointDraw");var ft=rt;function qe(e,t=ft){if(dt(t),!Number.isSafeInteger(e)||e<0)throw new RangeError(`A point store needs a non-negative slot count, not ${e}.`);let r=[];for(let o=0;o<e;o+=t)r.push(Object.freeze({first:o,count:Math.min(t,e-o)}));return Object.freeze(r)}m(qe,"planStoreSegments");function Ze(e,t,r,o){if(r<=0)return 0;let i=t+r,a=e[0].count,s=Math.min(e.length-1,Math.floor(t/a)),n=0;for(;s<e.length;s++){let d=e[s],h=d.first+d.count;if(h<=t)continue;if(d.first>=i)break;let g=Math.max(t,d.first),_=Math.min(i,h);o(s,g-d.first,_-g),n++}return n}m(Ze,"forEachSegmentRange");function vt(e,t){if(e instanceof Fe)return vt(e.segments,t);if(!Array.isArray(e)){if(!e)throw new TypeError("A point store needs a buffer or a list of segments.");return[{buffer:e,first:0,count:t}]}let r=0;for(let o of e){if(!o?.buffer||o.first!==r||!Number.isSafeInteger(o.count)||o.count<=0)throw new TypeError("A segmented point store needs consecutive {buffer, first, count} segments.");r+=o.count}if(r!==t)throw new RangeError(`A segmented point store holds ${r} slots, not ${t}.`);return e}m(vt,"requireStoreSegments");function dt(e){if(!Number.isSafeInteger(e)||e<=0)throw new RangeError(`A point store segment holds a positive number of slots, not ${e}.`)}m(dt,"requireSegmentPoints");var Fe=class{static{m(this,"PointStore")}constructor(t,r=ft){dt(r),this.gl=t,this.segmentPoints=r,this.segments=[],this.pointCount=0,this.bytesPerPoint=0,this.deleted=!1}get byteLength(){return this.pointCount*this.bytesPerPoint}get allocatedByteLength(){let t=0;for(let r of this.segments)t+=r.capacity;return t*this.bytesPerPoint}allocate(t,r,o,i,a,s=null){let n=this.gl;if(s!==null&&s.byteLength!==t*r)throw new RangeError(`${a}: the data holds ${ie(s.byteLength,"byte")}, not ${tt(t*r)}.`);let d=qe(t,this.segmentPoints),h=this.segments;this.segments=[],this.pointCount=0,this.bytesPerPoint=r;try{for(let g=0;g<d.length;g++){let{first:_,count:u}=d[g],f=g<h.length?h[g].buffer:n.createBuffer();if(g<h.length&&(h[g]=null),!f)throw new Error(`${a}: no buffer could be created.`);this.segments.push({buffer:f,first:_,count:u,capacity:u}),n.bindBuffer(n.ARRAY_BUFFER,f);let l=u*r;i(`${a} (segment ${g+1} of ${d.length}, ${ie(l,"byte")})`,()=>{if(s===null)n.bufferData(n.ARRAY_BUFFER,l,o);else{let y=r/s.BYTES_PER_ELEMENT;n.bufferData(n.ARRAY_BUFFER,s,o,_*y,u*y)}})}this.pointCount=t}finally{for(let g of h)g!==null&&n.deleteBuffer(g.buffer);n.bindBuffer(n.ARRAY_BUFFER,null)}return this.byteLength}resize(t,r,o,i,a=t){let s=this.gl,n=this.bytesPerPoint;if(!(n>0))throw new Error(`${i}: a store is allocated before it is resized.`);if(!Number.isSafeInteger(a)||a<t)throw new RangeError(`${i}: a capacity of ${a} slots does not hold ${ie(t,"point")}.`);let d=qe(t,this.segmentPoints),h=qe(a,this.segmentPoints),g=this.segments,_=[],u=[];try{for(let l=0;l<d.length;l++){let{first:y,count:x}=d[l],w=g[l]??null;if(w!==null&&w.capacity>=x){_.push(w.count===x?w:{...w,count:x});continue}let b=s.createBuffer();if(!b)throw new Error(`${i}: no buffer could be created.`);u.push(b),s.bindBuffer(s.ARRAY_BUFFER,b);let S=h[l].count,T=S*n;o(`${i} (segment ${l+1} of ${d.length}, ${ie(T,"byte")})`,()=>{s.bufferData(s.ARRAY_BUFFER,T,r)}),w!==null&&(s.bindBuffer(s.COPY_READ_BUFFER,w.buffer),s.bindBuffer(s.COPY_WRITE_BUFFER,b),s.copyBufferSubData(s.COPY_READ_BUFFER,s.COPY_WRITE_BUFFER,0,0,Math.min(w.count,x)*n),s.bindBuffer(s.COPY_READ_BUFFER,null),s.bindBuffer(s.COPY_WRITE_BUFFER,null)),_.push({buffer:b,first:y,count:x,capacity:S})}}catch(l){for(let y of u)s.deleteBuffer(y);throw l}finally{s.bindBuffer(s.ARRAY_BUFFER,null)}let f=new Set(_.map(l=>l.buffer));for(let l of g)f.has(l.buffer)||s.deleteBuffer(l.buffer);return this.segments=_,this.pointCount=t,this.byteLength}write(t,r=0){let o=this.gl,i=this.bytesPerPoint/t.BYTES_PER_ELEMENT,a=t.length/i;if(!Number.isInteger(a)||r<0||r+a>this.pointCount)throw new RangeError(`A point store of ${ie(this.pointCount,"point")} cannot take ${ie(t.length,"element")} at point ${r}.`);try{Ze(this.segments,r,a,(s,n,d)=>{let h=this.segments[s];o.bindBuffer(o.ARRAY_BUFFER,h.buffer),o.bufferSubData(o.ARRAY_BUFFER,n*this.bytesPerPoint,t,(h.first+n-r)*i,d*i)})}finally{o.bindBuffer(o.ARRAY_BUFFER,null)}}read(t){let r=this.gl,o=this.bytesPerPoint/t.BYTES_PER_ELEMENT;try{for(let i of this.segments){let a=Math.min(i.count,t.length/o-i.first);if(a<=0)break;r.bindBuffer(r.ARRAY_BUFFER,i.buffer),r.getBufferSubData(r.ARRAY_BUFFER,0,t,i.first*o,a*o)}}finally{r.bindBuffer(r.ARRAY_BUFFER,null)}return t}delete(){for(;this.segments.length>0;)this.gl.deleteBuffer(this.segments[this.segments.length-1].buffer),this.segments.pop();this.pointCount=0,this.deleted=!0}},ut=class{static{m(this,"SegmentedVertexArray")}constructor(t){this.gl=t,this.vaos=[],this.segments=[],this.positionBuffers=[],this.deleted=!1}setStores(t,r,o){let i=this.gl;for(bt(t,r);this.vaos.length>t.segments.length;)i.deleteVertexArray(this.vaos.pop());for(;this.vaos.length<t.segments.length;){let a=i.createVertexArray();if(!a)throw new Error("A point store could not create its vertex array.");this.vaos.push(a)}this.segments=t.segments.map(({first:a,count:s})=>({first:a,count:s})),this.positionBuffers=t.segments.map(a=>a.buffer);try{for(let a=0;a<this.vaos.length;a++)i.bindVertexArray(this.vaos[a]),i.bindBuffer(i.ARRAY_BUFFER,t.segments[a].buffer),i.enableVertexAttribArray(0),i.vertexAttribPointer(0,o,i.FLOAT,!1,o*4,0),ht(i,r===null?null:r.segments[a].buffer,this.positionBuffers[a])}finally{i.bindVertexArray(null),i.bindBuffer(i.ARRAY_BUFFER,null)}}setColors(t){let r=this.gl;if(t!==null&&t.segments.length!==this.vaos.length)throw new RangeError("A colour store must have the segments of the positions it is drawn with.");try{for(let o=0;o<this.vaos.length;o++)r.bindVertexArray(this.vaos[o]),ht(r,t===null?null:t.segments[o].buffer,this.positionBuffers[o])}finally{r.bindVertexArray(null),r.bindBuffer(r.ARRAY_BUFFER,null)}}drawRange(t,r,o,i){let a=this.gl,s=0;try{Ze(this.segments,t,r,(n,d,h)=>{a.bindVertexArray(this.vaos[n]),o(this.segments[n].first),s+=i(a,d,h)})}finally{a.bindVertexArray(null)}return s}delete(){for(;this.vaos.length>0;)this.gl.deleteVertexArray(this.vaos[this.vaos.length-1]),this.vaos.pop();this.segments=[],this.positionBuffers=[],this.deleted=!0}};function xo(e,t,r,o,i,a){let s=o+e.length;(!(i.starts instanceof Int32Array)||i.starts.length<s)&&(i.starts=new Int32Array(s),i.counts=new Int32Array(s));let n=-1,d=0,h=m(()=>{n>=0&&d>0&&a(n,i.starts,i.counts,d),d=0},"flush");for(let g=0;g<o;g++)Ze(e,t[g],r[g],(_,u,f)=>{_!==n&&(h(),n=_),i.starts[d]=u,i.counts[d]=f,d++});h()}m(xo,"splitRangesBySegment");function ht(e,t,r){if(t===null){it(e,1,r);return}e.bindBuffer(e.ARRAY_BUFFER,t),e.enableVertexAttribArray(1),e.vertexAttribPointer(1,4,e.UNSIGNED_BYTE,!0,4,0)}m(ht,"bindColorAttribute");function bt(e,t){if(!(e instanceof Fe))throw new TypeError("A segmented vertex array needs a position store.");if(t!==null&&(!(t instanceof Fe)||t.segments.length!==e.segments.length||t.segments.some((r,o)=>r.count!==e.segments[o].count)))throw new RangeError("A colour store must have the segments of the positions it is drawn with.")}m(bt,"requireMatchingSegments");function pt(e){let t=e>>>0;return m(function(){t+=1831565813;let o=Math.imul(t^t>>>15,t|1);return o^=o+Math.imul(o^o>>>7,o|61),((o^o>>>14)>>>0)/4294967296},"next")}m(pt,"createMulberry32");function le(e,t,r){return at(e|0,t,r)}m(le,"clampInt");function ze(e,t,r=0,o=0){return{x:new Float32Array(0),y:new Float32Array(0),rgba:new Uint8Array(0),alpha:new Float32Array(0),index:new Uint32Array(0),sourcePositions:new Float32Array(0),highlighted:new Uint8Array(0),scannedSourceCount:r,candidateSourceCount:o,viewportWidth:e,viewportHeight:t}}m(ze,"createEmptyReducedViewportPoints");function Je(e,t,r){let o=e.length,i=new Uint32Array(o);if(r===0)return i;if(!Number.isSafeInteger(t)||!Number.isSafeInteger(r)||t<0||r<0||r>t)throw new RangeError("Figure-export density allocation requires an exact target within its population.");let a=new Float64Array(o),s=[],n=0;for(let l=0;l<o;l++)e[l]>0&&n++;let d=r>=n,h=d?n:0,g=r-h,_=t-h,u=0;for(let l=0;l<o;l++){let y=e[l];if(!y)continue;let x=d?1:0,w=y-x,b=g>0&&_>0?w/_*g:0,S=Math.floor(b),T=x+S;i[l]=T,u+=T,T<y&&(a[l]=b-S,s.push(l))}let f=r-u;if(f>0){s.sort((l,y)=>a[y]-a[l]||l-y);for(let l=0;l<s.length&&f>0;l++)i[s[l]]++,f--}if(f!==0)throw new Error("Figure-export density allocation could not satisfy the exact target.");return i}m(Je,"apportionDensitySlots");function Lo({positions:e,dimension:t,colors:r,transparency:o=null,lodMembership:i=null,highlightArray:a=null,highlightedIndices:s=null,renderState:n,targetCount:d,crop:h=null,gridSize:g=160,maxScanPoints:_=null,seed:u=1337}){if(!e||!r||!n?.mvpMatrix)return ze(n?.viewportWidth||1,n?.viewportHeight||1);let f=Pe(e,t,"Figure-export density positions",{allowEmpty:!0}),l=Math.min(f,Math.floor(r.length/4)),y=Number.isFinite(d)?Math.max(0,Math.floor(d)):0;if(_!==null&&(!Number.isSafeInteger(_)||_<1))throw new RangeError("Figure-export density maxScanPoints must be null or a positive safe integer.");if(nt(i,{pointCount:f,owner:"Figure-export density LOD membership"}),a!==null&&(!(a instanceof Uint8Array)||a.length!==f))throw new TypeError("Figure-export density highlightArray must be null or one exact Uint8 value per source point.");if(s!==null&&(a===null||!Array.isArray(s)&&!(s instanceof Uint32Array)))throw new TypeError("Figure-export density highlightedIndices require highlightArray and must be an Array or Uint32Array.");let x=null;if(s!==null&&s.length<=y){x=new Set;for(let v of s){if(!Number.isSafeInteger(v)||v<0||v>=f||x.has(v)||a[v]<Be)throw new RangeError("Figure-export density highlightedIndices must be unique visible highlight IDs in the current source generation.");x.add(v)}}let w=i?.indices??null,b=i===null?l:Math.min(l,i.count),S=_===null?b:Math.min(b,_),T=S===0?0:Math.floor(b/S),oe=S===0?0:b%S,O=Math.max(1,n.viewportWidth||1),V=Math.max(1,n.viewportHeight||1),c=n.mvpMatrix,_e=Te(h),p=Le(_e,O,V),H=!!(p&&(p.width<O-.5||p.height<V-.5||p.x>.5||p.y>.5)),F=H?p.width:O,P=H?p.height:V;if(y===0)return ze(F,P,0,b);let A=le(g,32,512),I=le(g,32,512),q=A*I,de=new Uint32Array(q),Z=a===null?null:new Uint32Array(q),G=x!==null&&S<b?new Set:null,J=0,Q=0,C=0,Y=0,$=0;for(let v=0;v<S;v++){let M=Y;Y+=T,$+=oe,$>=S&&(Y++,$-=S);let R=w===null?M:w[M];if(R>=l)continue;let j=a!==null&&a[R]>=Be;j&&G!==null&&G.add(R);let k=o?o[R]??1:1,E=Number.isFinite(k)?k:1;if(E<0?E=0:E>1&&(E=1),E<ge)continue;let B=R*t,K=e[B],ee=t>1?e[B+1]:0,te=t>2?e[B+2]:0,X=c[0]*K+c[4]*ee+c[8]*te+c[12],ne=c[1]*K+c[5]*ee+c[9]*te+c[13],ae=c[2]*K+c[6]*ee+c[10]*te+c[14],U=c[3]*K+c[7]*ee+c[11]*te+c[15];if(!Number.isFinite(U)||U<=0)continue;let N=X/U,D=ne/U,he=ae/U;if(N<-1||N>1||D<-1||D>1||he<-1||he>1)continue;let re=(N*.5+.5)*O,z=(-D*.5+.5)*V;if(H&&p){if(re<p.x||re>p.x+p.width||z<p.y||z>p.y+p.height)continue;re-=p.x,z-=p.y}let we=le(re/F*A,0,A-1),L=le(z/P*I,0,I-1)*A+we;de[L]++,j&&(Z[L]++,Q++),J++}if(G!==null)for(let v of x){if(G.has(v)||(C++,v>=l||!ke(i,v)))continue;let M=o?o[v]??1:1,R=Number.isFinite(M)?M:1;if(R<0?R=0:R>1&&(R=1),R<ge)continue;let j=v*t,k=e[j],E=t>1?e[j+1]:0,B=t>2?e[j+2]:0,K=c[0]*k+c[4]*E+c[8]*B+c[12],ee=c[1]*k+c[5]*E+c[9]*B+c[13],te=c[2]*k+c[6]*E+c[10]*B+c[14],X=c[3]*k+c[7]*E+c[11]*B+c[15];if(!Number.isFinite(X)||X<=0)continue;let ne=K/X,ae=ee/X,U=te/X;if(ne<-1||ne>1||ae<-1||ae>1||U<-1||U>1)continue;let N=(ne*.5+.5)*O,D=(-ae*.5+.5)*V;if(H&&p){if(N<p.x||N>p.x+p.width||D<p.y||D>p.y+p.height)continue;N-=p.x,D-=p.y}let he=le(N/F*A,0,A-1),z=le(D/P*I,0,I-1)*A+he;de[z]++,Z[z]++,J++,Q++}if(J<=0)return ze(F,P,S+C,b);let ce=Math.min(y,J);if(ce===0)return ze(F,P,S+C,b);let se=new Uint32Array(q),Se;if(Z!==null&&Q>0)if(Q<=ce){se=Z;let v=new Uint32Array(q);for(let M=0;M<q;M++)v[M]=de[M]-Z[M];Se=Je(v,J-Q,ce-Q)}else se=Je(Z,Q,ce),Se=new Uint32Array(q);else Se=Je(de,J,ce);let Re=new Uint32Array(q),Me=0;for(let v=0;v<q;v++)Re[v]=Me,Me+=se[v]+Se[v];let pe=Me;if(pe!==ce)throw new Error("Figure-export density quotas do not match the exact output target.");let Ue=new Float32Array(pe),Oe=new Float32Array(pe),ue=new Uint8Array(pe*4),He=new Float32Array(pe),Ge=new Uint32Array(pe),xe=new Float32Array(pe*3),Ye=new Uint8Array(pe),Qe=new Uint32Array(q),gt=new Uint32Array(q),Ke=pt(u);Y=0,$=0;for(let v=0;v<S;v++){let M=Y;Y+=T,$+=oe,$>=S&&(Y++,$-=S);let R=w===null?M:w[M];if(R>=l)continue;let j=a!==null&&a[R]>=Be,k=o?o[R]??1:1,E=Number.isFinite(k)?k:1;if(E<0?E=0:E>1&&(E=1),E<ge)continue;let B=R*t,K=e[B],ee=t>1?e[B+1]:0,te=t>2?e[B+2]:0,X=c[0]*K+c[4]*ee+c[8]*te+c[12],ne=c[1]*K+c[5]*ee+c[9]*te+c[13],ae=c[2]*K+c[6]*ee+c[10]*te+c[14],U=c[3]*K+c[7]*ee+c[11]*te+c[15];if(!Number.isFinite(U)||U<=0)continue;let N=X/U,D=ne/U,he=ae/U;if(N<-1||N>1||D<-1||D>1||he<-1||he>1)continue;let re=(N*.5+.5)*O,z=(-D*.5+.5)*V;if(H&&p){if(re<p.x||re>p.x+p.width||z<p.y||z>p.y+p.height)continue;re-=p.x,z-=p.y}let we=le(re/F*A,0,A-1),L=le(z/P*I,0,I-1)*A+we,Ee=j?se:Se,ve=j?Qe:gt,ye=Ee[L];if(!ye)continue;let be=++ve[L],fe;if(be<=ye)fe=Re[L]+(j?0:se[L])+(be-1);else{let et=Math.floor(Ke()*be);if(et>=ye)continue;fe=Re[L]+(j?0:se[L])+et}Ue[fe]=re,Oe[fe]=z;let $e=R*4,Ie=fe*4;ue[Ie]=r[$e],ue[Ie+1]=r[$e+1],ue[Ie+2]=r[$e+2],ue[Ie+3]=255,He[fe]=E,Ge[fe]=R;let je=fe*3;xe[je]=K,xe[je+1]=ee,xe[je+2]=te,Ye[fe]=j?a[R]:0}if(G!==null)for(let v of x){if(G.has(v)||v>=l||!ke(i,v))continue;let M=o?o[v]??1:1,R=Number.isFinite(M)?M:1;if(R<0?R=0:R>1&&(R=1),R<ge)continue;let j=v*t,k=e[j],E=t>1?e[j+1]:0,B=t>2?e[j+2]:0,K=c[0]*k+c[4]*E+c[8]*B+c[12],ee=c[1]*k+c[5]*E+c[9]*B+c[13],te=c[2]*k+c[6]*E+c[10]*B+c[14],X=c[3]*k+c[7]*E+c[11]*B+c[15];if(!Number.isFinite(X)||X<=0)continue;let ne=K/X,ae=ee/X,U=te/X;if(ne<-1||ne>1||ae<-1||ae>1||U<-1||U>1)continue;let N=(ne*.5+.5)*O,D=(-ae*.5+.5)*V;if(H&&p){if(N<p.x||N>p.x+p.width||D<p.y||D>p.y+p.height)continue;N-=p.x,D-=p.y}let he=le(N/F*A,0,A-1),z=le(D/P*I,0,I-1)*A+he,we=se[z];if(!we)continue;let Ae=++Qe[z],L;if(Ae<=we)L=Re[z]+(Ae-1);else{let be=Math.floor(Ke()*Ae);if(be>=we)continue;L=Re[z]+be}Ue[L]=N,Oe[L]=D;let Ee=v*4,ve=L*4;ue[ve]=r[Ee],ue[ve+1]=r[Ee+1],ue[ve+2]=r[Ee+2],ue[ve+3]=255,He[L]=R,Ge[L]=v;let ye=L*3;xe[ye]=k,xe[ye+1]=E,xe[ye+2]=B,Ye[L]=a[v]}return{x:Ue,y:Oe,rgba:ue,alpha:He,index:Ge,sourcePositions:xe,highlighted:Ye,scannedSourceCount:S+C,candidateSourceCount:b,viewportWidth:F,viewportHeight:P}}m(Lo,"reducePointsByDensity");export{Xe as a,_t as b,Ft as c,It as d,We as e,Dt as f,zt as g,Mt as h,Ut as i,Ot as j,Ht as k,Vt as l,lt as m,Xt as n,Wt as o,qt as p,Zt as q,Jt as r,Qt as s,Kt as t,eo as u,to as v,oo as w,ro as x,io as y,no as z,ao as A,uo as B,ho as C,fo as D,ft as E,Ze as F,vt as G,Fe as H,ut as I,xo as J,mt as K,Et as L,Pt as M,Lo as N};
