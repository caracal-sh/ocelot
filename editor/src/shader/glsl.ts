// The GLSL ES 3.00 fragment shaders of the shader kinds, written for Ocelot (no third-party shader code).
//
// Shared conventions (declared by `fragmentSource` in source.ts):
//   u_res   canvas size in device pixels          u_dpr    device pixels per layer (CSS) pixel
//   u_phase seconds of motion (speed applied)     u_seed   integer seed
//   u_c[5]  colours (OKLab for the gradients, sRGB for halftone and dither), u_a[5] their alpha, u_n how many are used
//   u_<param> one float per parameter of the kind; a select is its option index, a boolean 0 or 1.
//   u_time  seconds since mount, speed applied (orbits and drifts; u_phase adds the seed offset for the noise)
// Output is premultiplied alpha. Where the pixel position matters (grain, dither cells), it comes from gl_FragCoord so patterns sit on
// whole device pixels and never shimmer.

/** Hashing and noise: PCG integer hash, quintic gradient noise in 3D, fractal sum. */
const NOISE = /* glsl */ `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float u01(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
uint SH;
float white(ivec2 p, uint salt) { return u01(pcg(uint(p.x & 0xFFFF) * 0x9E3779B1u ^ uint(p.y & 0xFFFF) * 0x85EBCA77u ^ salt * 0xC2B2AE3Du)); }
vec3 grad3(ivec3 c) {
  uint h = pcg(uint(c.x & 0xFFFF) * 0x9E3779B1u ^ uint(c.y & 0xFFFF) * 0x85EBCA77u ^ uint(c.z & 0xFFFF) * 0xC2B2AE3Du ^ SH);
  return vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 20u) & 1023u)) * (2.0 / 1023.0) - 1.0;
}
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec3 c = ivec3(i);
  float n000 = dot(grad3(c), f);
  float n100 = dot(grad3(c + ivec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(grad3(c + ivec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(grad3(c + ivec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(grad3(c + ivec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(grad3(c + ivec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(grad3(c + ivec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(grad3(c + ivec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * gnoise(p);
    p.xy = ROT * p.xy * 2.03 + 11.7;
    p.z += 3.1;
    a *= 0.5;
  }
  return s * 1.6;
}
`;

const COLOR = /* glsl */ `
vec3 lab2lin(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 encode(vec3 lin) {
  lin = clamp(lin, 0.0, 1.0);
  return mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}
// Triangular noise of one 8-bit step: adding it before the 8-bit quantisation turns banding into invisible noise.
float tpdf(ivec2 p) { return (white(p, 0x51u) + white(p, 0xA3u) - 1.0) / 255.0; }
`;

/** Layer position in units of the short side, y down, origin in the centre. */
const COORDS = /* glsl */ `
ivec2 pixel() { return ivec2(int(gl_FragCoord.x), int(u_res.y) - 1 - int(gl_FragCoord.y)); }
float shortSide() { return min(u_res.x, u_res.y); }
vec2 toQ(vec2 devicePx) { return (devicePx - 0.5 * u_res) / shortSide(); }
`;

export const GRAIN_GRADIENT = /* glsl */ `
void main() {
  SH = pcg(SEEDU);
  ivec2 pix = pixel();
  vec2 q = toQ(vec2(pix) + 0.5);
  float a = radians(u_angle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 r = vec2(dot(q, dir), dot(q, vec2(-dir.y, dir.x)));
  vec2 p = r * (1.5 / u_scale);
  float z = u_phase * 0.22;
  p.x -= u_phase * 0.12;
  vec2 w = vec2(gnoise(vec3(p * 0.9 + vec2(3.1, 1.7), z)), gnoise(vec3(p * 0.9 + vec2(7.3, 5.9), z + 4.0)));
  p += u_warp * 1.1 * w;
  float x = 0.46 + 1.25 * fbm(vec3(p, z + 9.0)) + 0.3 * r.x / u_scale;
  x = smoothstep(0.02, 0.98, x);
  float gs = max(1.0, floor(u_grain_size * u_dpr + 0.5));
  float n = white(pix / int(gs), 0x77u) - 0.5;
  float n2 = white(pix / int(gs), 0x78u) - 0.5;
  x += (n + n2) * u_grain * 0.6;
  float s = clamp(x, 0.0, 1.0) * (u_n - 1.0);
  float i = min(floor(s), u_n - 2.0);
  float t = s - i;
  float wd = mix(0.0015, 0.5, pow(u_softness, 1.6));
  t = smoothstep(0.5 - wd, 0.5 + wd, t);
  vec3 lab = mix(u_c[int(i)], u_c[int(i) + 1], t);
  o = vec4(encode(lab2lin(lab)) + tpdf(pix), 1.0);
}
`;

export const MESH_GRADIENT = /* glsl */ `
void main() {
  SH = pcg(SEEDU);
  ivec2 pix = pixel();
  vec2 res = u_res / shortSide();
  vec2 q = toQ(vec2(pix) + 0.5);
  float r = radians(u_angle);
  float cs = cos(r);
  float sn = sin(r);
  vec3 lab = vec3(0.0);
  float sum = 0.0;
  vec2 p = q + u_warp * 0.28 * vec2(gnoise(vec3(q * 1.7, u_phase * 0.18)), gnoise(vec3(q * 1.7 + 9.7, u_phase * 0.18 + 3.0)));
  p += u_warp * 0.12 * vec2(gnoise(vec3(q * 3.9 + 4.0, u_phase * 0.3)), gnoise(vec3(q * 3.9 - 4.0, u_phase * 0.3 + 5.0)));
  float k = mix(3.2, 0.85, u_softness);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= u_n) break;
    uint h = pcg(uint(i) * 7919u + pcg(SEEDU + 17u));
    uint h2 = pcg(h + 101u);
    uint h3 = pcg(h2 + 202u);
    float ang = (float(i) + 0.55 * u01(h)) / u_n * 6.2831853 + 6.2831853 * u01(h2);
    float rad = (0.2 + 0.2 * u01(h3)) * u_scale;
    vec2 pos = vec2(cos(ang), sin(ang)) * rad * res * 1.15;
    pos = vec2(pos.x * cs - pos.y * sn, pos.x * sn + pos.y * cs);
    pos += 0.1 * vec2(sin(u_phase * (0.35 + 0.3 * u01(h2)) + 6.28 * u01(h)), cos(u_phase * (0.3 + 0.3 * u01(h3)) + 6.28 * u01(h3)));
    vec2 d = p - pos;
    float wgt = 1.0 / pow(dot(d, d) + 0.004, k);
    lab += wgt * u_c[i];
    sum += wgt;
  }
  lab /= sum;
  float n = white(pix, 0x91u) + white(pix, 0x92u) - 1.0;
  lab.x += n * u_grain * 0.09;
  o = vec4(encode(lab2lin(lab)) + tpdf(pix), 1.0);
}
`;

/** Tonal fields shared by halftone and dither: brightness 0 (dark) to 1 (light) at a layer position `q`. */
const FIELDS = /* glsl */ `
vec2 warped(vec2 q) {
  return q + u_warp * 0.14 * vec2(gnoise(vec3(q * 2.3, u_phase * 0.1)), gnoise(vec3(q * 2.3 + 6.1, u_phase * 0.1 + 2.0)));
}
float f_linear(vec2 q, float bg) {
  q = warped(q);
  float a = radians(u_direction);
  vec2 d = vec2(cos(a), sin(a));
  vec2 half_ = abs(0.5 * u_res / shortSide());
  float extent = 2.0 * (abs(d.x) * half_.x + abs(d.y) * half_.y);
  return clamp(0.5 + (dot(q, d) - 0.12 * sin(u_time * 0.6)) / (extent * u_scale), 0.0, 1.0);
}
float f_radial(vec2 q, float bg) {
  q = warped(q);
  vec2 c = 0.1 * vec2(cos(u_time * 0.5), sin(u_time * 0.4));
  float r = length(q - c) / (0.62 * u_scale);
  return clamp(r * r * 0.55 + r * 0.45, 0.0, 1.0);
}
float f_noise(vec2 q, float bg) {
  return clamp(0.5 + 0.9 * fbm(vec3(q / (0.38 * u_scale) + vec2(u_phase * 0.05, 0.0), u_phase * 0.12)), 0.0, 1.0);
}
float f_sphere(vec2 q, float bg) {
  q = warped(q);
  float R = 0.34 * u_scale;
  vec2 c = vec2(0.0);
  vec2 v = (q - c) / R;
  float r2 = dot(v, v);
  float az = radians(u_direction) + u_time * 0.35;
  vec3 L = normalize(vec3(cos(az) * 0.75, sin(az) * 0.75, 0.62));
  vec3 N = vec3(v, sqrt(max(0.0, 1.0 - r2)));
  float lit = clamp(dot(N, L), 0.0, 1.0);
  float shade = 0.04 + 0.92 * pow(lit, 0.85);
  float m = 1.0 - smoothstep(0.985, 1.0, r2);
  return mix(bg, shade, m);
}
float f_waves(vec2 q, float bg) {
  q = warped(q);
  float a = radians(u_direction);
  vec2 d1 = vec2(cos(a), sin(a));
  vec2 d2 = vec2(cos(a + 1.9), sin(a + 1.9));
  float f = 7.0 / u_scale;
  float s = 0.42 * sin(dot(q, d1) * f + u_phase * 1.1)
          + 0.34 * sin(dot(q, d2) * f * 1.3 - u_phase * 0.8)
          + 0.34 * sin(length(q - vec2(0.18, -0.1)) * f * 1.15 - u_phase * 0.9);
  return clamp(0.5 + 0.5 * s * 0.95, 0.0, 1.0);
}
`;

export const HALFTONE = /* glsl */ `
float field(vec2 q) {
  int k = int(u_field + 0.5);
  if (k == 0) return f_linear(q, 1.0);
  if (k == 1) return f_radial(q, 1.0);
  if (k == 2) return f_noise(q, 1.0);
  return f_sphere(q, 1.0);
}
float tone(vec2 centreDevice) {
  float b = field(toQ(centreDevice));
  float ink = (u_invert > 0.5) ? b : 1.0 - b;
  return clamp((ink - 0.5) * u_contrast + 0.5, 0.0, 1.0);
}
void main() {
  SH = pcg(SEEDU);
  vec2 fc = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  float cell = max(2.0, u_cell * u_dpr);
  float a = radians(u_angle);
  float ca = cos(a);
  float sa = sin(a);
  mat2 R = mat2(ca, -sa, sa, ca);
  vec2 mid = 0.5 * u_res;
  vec2 rp = R * (fc - mid);
  int shape = int(u_shape + 0.5);
  // rp is continuous across cells (the nearest-centre distance below is not): its derivative is one device pixel.
  float px = max(length(vec2(dFdx(rp.x), dFdy(rp.x))), length(vec2(dFdx(rp.y), dFdy(rp.y))));
  float aa = px * (1.0 + u_softness * cell * 0.42);
  float cov = 0.0;
  if (shape == 1) {
    float row = floor(rp.y / cell);
    float cy = (row + 0.5) * cell;
    vec2 centre = transpose(R) * vec2(rp.x, cy) + mid;
    float ink = tone(centre);
    float d = abs(rp.y - cy);
    cov = clamp((0.5 * cell * ink - d) / aa + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.06, ink);
  } else {
    vec2 base = floor(rp / cell - 0.5);
    for (int j = 0; j < 4; j++) {
      vec2 cid = base + vec2(float(j & 1), float(j >> 1));
      vec2 cen = (cid + 0.5) * cell;
      float ink = tone(transpose(R) * cen + mid);
      vec2 dv = rp - cen;
      float d;
      float r;
      if (shape == 0) {
        d = length(dv);
        r = (cell * 0.7071 + px) * sqrt(ink);
      } else {
        d = max(abs(dv.x), abs(dv.y));
        r = (cell * 0.5 + 0.5 * px) * sqrt(ink);
      }
      cov = max(cov, clamp((r - d) / aa + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.06, ink));
    }
  }
  vec4 ink = vec4(u_c[0] * u_a[0], u_a[0]);
  vec4 paper = vec4(u_c[1] * u_a[1], u_a[1]);
  o = mix(paper, ink, cov);
}
`;

/** 8x8 Bayer value of an integer cell, by the recursive definition M(2n) = [[4M, 4M+2], [4M+3, 4M+1]]. */
const BAYER = /* glsl */ `
float bayer(ivec2 c, int levels) {
  float v = 0.0;
  float w = 1.0;
  for (int k = 0; k < 3; k++) {
    if (k >= levels) break;
    int bx = (c.x >> k) & 1;
    int by = (c.y >> k) & 1;
    float base = float(((bx ^ by) << 1) | by);
    v += base * pow(4.0, float(levels - 1 - k));
  }
  return (v + 0.5) / pow(4.0, float(levels));
}
`;

export const DITHER = /* glsl */ `
float field(vec2 q) {
  int k = int(u_field + 0.5);
  if (k == 0) return f_waves(q, 0.1);
  if (k == 1) return f_noise(q, 0.1);
  if (k == 2) return f_sphere(q, 0.08);
  return f_linear(q, 0.1);
}
void main() {
  SH = pcg(SEEDU);
  ivec2 pix = pixel();
  int cs = max(1, int(floor(u_pixel * u_dpr + 0.5)));
  ivec2 cid = pix / cs;
  vec2 centre = (vec2(cid) + 0.5) * float(cs);
  float b = field(toQ(centre));
  b = clamp((b - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  int levels = int(u_matrix + 0.5) + 1;
  float thr = bayer(cid, levels);
  float v = b * (u_n - 1.0);
  float lo = floor(v);
  float idx = min(lo + step(thr, v - lo), u_n - 1.0);
  int ci = int(idx);
  o = vec4(u_c[ci] * u_a[ci], u_a[ci]);
}
`;

export const GRAIN = /* glsl */ `
float lattice(vec2 p, uint salt, float soft) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float w = mix(0.0, 0.5, soft);
  f = smoothstep(0.5 - w - 1e-4, 0.5 + w + 1e-4, f);
  ivec2 c = ivec2(i);
  float a = white(c, salt);
  float b = white(c + ivec2(1, 0), salt);
  float d = white(c + ivec2(0, 1), salt);
  float e = white(c + ivec2(1, 1), salt);
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
float grainAt(vec2 p, uint salt, float soft) {
  return (lattice(p, salt, soft) + lattice(p + 41.3, salt + 7u, soft)) - 1.0;
}
void main() {
  SH = pcg(SEEDU);
  vec2 fc = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  float gs = max(1.0, u_size * u_dpr);
  vec2 p = fc / gs;
  uint frame = uint(floor(u_phase * 24.0));
  uint salt = pcg(SEEDU + frame * 977u);
  float gain = 1.0 + u_softness * 1.1;
  vec3 n = vec3(grainAt(p, salt, u_softness));
  if (u_tone > 0.5) n = vec3(n.x, grainAt(p, salt + 13u, u_softness), grainAt(p, salt + 29u, u_softness));
  n = clamp(n * gain * u_intensity * 1.7, -1.0, 1.0);
  vec3 light = max(n, 0.0);
  float dark = max(-(n.x + n.y + n.z) / 3.0, 0.0);
  float al = max(max(light.x, max(light.y, light.z)), dark);
  o = vec4(light, al);
}
`;

export const GLSL = { NOISE, COLOR, COORDS, FIELDS, BAYER };
