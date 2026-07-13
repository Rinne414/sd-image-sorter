/**
 * gallery/color-histogram.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 4044-4178 (of 4,708): _extractColorDistribution canvas color histogram.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _extractColorDistribution(imgEl) {
        const container = document.getElementById('modal-color-distribution');
        const histCanvas = document.getElementById('modal-color-histogram-canvas');
        const paletteEl = document.getElementById('modal-color-palette');
        if (!container || !histCanvas || !paletteEl || !imgEl) return;

        const extract = () => {
            try {
                // Sample the image at a reasonable size
                const sampleCanvas = document.createElement('canvas');
                const sampleSize = 128;
                sampleCanvas.width = sampleSize;
                sampleCanvas.height = sampleSize;
                const sampleCtx = sampleCanvas.getContext('2d');
                sampleCtx.drawImage(imgEl, 0, 0, sampleSize, sampleSize);
                const data = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;
                const totalPixels = sampleSize * sampleSize;

                // === RGB Histogram ===
                const rHist = new Uint32Array(256);
                const gHist = new Uint32Array(256);
                const bHist = new Uint32Array(256);
                const lHist = new Uint32Array(256); // luminance

                // Color palette buckets
                const buckets = {};

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i+1], b = data[i+2];
                    rHist[r]++;
                    gHist[g]++;
                    bHist[b]++;
                    lHist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;

                    // Bucket for palette
                    const br = Math.round(r / 32) * 32;
                    const bg = Math.round(g / 32) * 32;
                    const bb = Math.round(b / 32) * 32;
                    const key = `${br},${bg},${bb}`;
                    if (!buckets[key]) buckets[key] = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
                    buckets[key].count++;
                    buckets[key].sumR += r;
                    buckets[key].sumG += g;
                    buckets[key].sumB += b;
                }

                // Draw histogram on canvas
                const rect = histCanvas.parentElement.getBoundingClientRect();
                const w = Math.max(256, Math.floor(rect.width * (window.devicePixelRatio || 1)));
                const h = Math.max(60, Math.floor(80 * (window.devicePixelRatio || 1)));
                histCanvas.width = w;
                histCanvas.height = h;
                const ctx = histCanvas.getContext('2d');
                ctx.clearRect(0, 0, w, h);

                // Find max value for normalization (skip 0 and 255 to avoid clipping spikes)
                let maxVal = 1;
                for (let i = 1; i < 255; i++) {
                    maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i]);
                }

                const drawChannel = (hist, color) => {
                    ctx.beginPath();
                    ctx.moveTo(0, h);
                    for (let i = 0; i < 256; i++) {
                        const x = (i / 255) * w;
                        const barH = Math.min(h, (hist[i] / maxVal) * h * 0.92);
                        ctx.lineTo(x, h - barH);
                    }
                    ctx.lineTo(w, h);
                    ctx.closePath();
                    ctx.fillStyle = color;
                    ctx.fill();
                };

                const mode = this._histogramMode || 'rgb';
                if (mode === 'luma') {
                    drawChannel(lHist, 'rgba(255,255,255,0.2)');
                } else if (mode === 'split') {
                    const drawLine = (hist, color, bandIndex) => {
                        const bandHeight = h / 3;
                        const bandTop = bandHeight * bandIndex;
                        ctx.beginPath();
                        ctx.moveTo(0, bandTop + bandHeight);
                        for (let i = 0; i < 256; i++) {
                            const x = (i / 255) * w;
                            const barH = Math.min(bandHeight, (hist[i] / maxVal) * bandHeight * 0.92);
                            ctx.lineTo(x, bandTop + bandHeight - barH);
                        }
                        ctx.strokeStyle = color;
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    };
                    drawLine(rHist, 'rgba(239,68,68,0.95)', 0);
                    drawLine(gHist, 'rgba(52,211,153,0.95)', 1);
                    drawLine(bHist, 'rgba(66,133,244,0.95)', 2);
                } else {
                    drawChannel(lHist, 'rgba(255,255,255,0.08)');
                    drawChannel(bHist, 'rgba(66,133,244,0.35)');
                    drawChannel(gHist, 'rgba(52,211,153,0.35)');
                    drawChannel(rHist, 'rgba(239,68,68,0.35)');
                }

                // === Color Palette ===
                const sorted = Object.values(buckets)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 9);
                const paletteTotal = sorted.reduce((s, b) => s + b.count, 0);

                paletteEl.innerHTML = sorted.map(b => {
                    const avgR = Math.round(b.sumR / b.count);
                    const avgG = Math.round(b.sumG / b.count);
                    const avgB = Math.round(b.sumB / b.count);
                    const hex = '#' + [avgR, avgG, avgB].map(v => v.toString(16).padStart(2, '0')).join('');
                    const pct = ((b.count / paletteTotal) * 100).toFixed(1);
                    return `<div class="modal-color-swatch" onclick="navigator.clipboard.writeText('${hex}')" title="Click to copy ${hex}">
                        <span class="swatch-dot" style="background:${hex}"></span>
                        <span>${hex}</span>
                        <span style="opacity:0.5">${pct}%</span>
                    </div>`;
                }).join('');

                container.style.display = '';
            } catch (e) {
                container.style.display = 'none';
            }
        };

        if (imgEl.complete && imgEl.naturalWidth > 0) {
            extract();
        } else {
            imgEl.addEventListener('load', extract, { once: true });
        }
    },

});
