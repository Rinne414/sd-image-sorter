/**
 * image-reader/color.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method body moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 805-930 (of 1,749): _renderReaderColorDistribution (canvas RGB/luma/
 * split histogram + dominant-palette swatches for the loaded preview image).
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _renderReaderColorDistribution() {
            const preview = document.getElementById('reader-image-preview');
            const section = document.getElementById('reader-color-section');
            const histCanvas = document.getElementById('reader-color-histogram-canvas');
            const paletteEl = document.getElementById('reader-color-palette');
            if (!preview || !section || !histCanvas || !paletteEl || !preview.naturalWidth) return;

            document.querySelectorAll('[data-reader-histogram-mode]').forEach((button) => {
                button.classList.toggle('active', button.dataset.readerHistogramMode === this._histogramMode);
            });

            try {
                const sampleCanvas = document.createElement('canvas');
                const sampleSize = 128;
                sampleCanvas.width = sampleSize;
                sampleCanvas.height = sampleSize;
                const sampleCtx = sampleCanvas.getContext('2d');
                sampleCtx.drawImage(preview, 0, 0, sampleSize, sampleSize);
                const data = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;

                const rHist = new Uint32Array(256);
                const gHist = new Uint32Array(256);
                const bHist = new Uint32Array(256);
                const lHist = new Uint32Array(256);
                const buckets = {};

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    rHist[r]++;
                    gHist[g]++;
                    bHist[b]++;
                    lHist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;

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

                const ctx = histCanvas.getContext('2d');
                const rect = histCanvas.parentElement.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                const width = Math.max(256, Math.floor(rect.width * dpr));
                const height = Math.max(96, Math.floor(96 * dpr));
                histCanvas.width = width;
                histCanvas.height = height;
                ctx.clearRect(0, 0, width, height);

                let maxVal = 1;
                for (let i = 1; i < 255; i++) {
                    maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i]);
                }

                const drawChannel = (hist, color) => {
                    ctx.beginPath();
                    ctx.moveTo(0, height);
                    for (let i = 0; i < 256; i++) {
                        const x = (i / 255) * width;
                        const barH = Math.min(height, (hist[i] / maxVal) * height * 0.92);
                        ctx.lineTo(x, height - barH);
                    }
                    ctx.lineTo(width, height);
                    ctx.closePath();
                    ctx.fillStyle = color;
                    ctx.fill();
                };

                const mode = this._histogramMode || 'rgb';
                if (mode === 'luma') {
                    drawChannel(lHist, 'rgba(255,255,255,0.2)');
                } else if (mode === 'split') {
                    const drawLine = (hist, color, bandIndex) => {
                        const bandHeight = height / 3;
                        const bandTop = bandHeight * bandIndex;
                        ctx.beginPath();
                        ctx.moveTo(0, bandTop + bandHeight);
                        for (let i = 0; i < 256; i++) {
                            const x = (i / 255) * width;
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

                const sorted = Object.values(buckets)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 9);
                const total = sorted.reduce((sum, bucket) => sum + bucket.count, 0) || 1;

                paletteEl.innerHTML = sorted.map((bucket) => {
                    const avgR = Math.round(bucket.sumR / bucket.count);
                    const avgG = Math.round(bucket.sumG / bucket.count);
                    const avgB = Math.round(bucket.sumB / bucket.count);
                    const hex = `#${[avgR, avgG, avgB].map(v => v.toString(16).padStart(2, '0')).join('')}`;
                    const pct = ((bucket.count / total) * 100).toFixed(1);
                    return `<div class="reader-color-swatch" onclick="navigator.clipboard.writeText('${hex}')" title="Copy ${hex}">
                        <span class="swatch-dot" style="background:${hex}"></span>
                        <span>${this._escapeHtml(hex)}</span>
                        <span class="reader-color-share">${this._escapeHtml(pct)}%</span>
                    </div>`;
                }).join('');

                section.style.display = '';
            } catch (_) {
                section.style.display = 'none';
            }
        },

});
