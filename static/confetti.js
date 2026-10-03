// Pure HTML5 Canvas Confetti Engine
function launchConfetti(durationSeconds = 4) {
    let canvas = document.getElementById("confetti-canvas");
    if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.id = "confetti-canvas";
        canvas.style.position = "fixed";
        canvas.style.top = "0";
        canvas.style.left = "0";
        canvas.style.width = "100vw";
        canvas.style.height = "100vh";
        canvas.style.pointerEvents = "none";
        canvas.style.zIndex = "9999";
        document.body.appendChild(canvas);
    }

    const ctx = canvas.getContext("2d");
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    window.addEventListener("resize", () => {
        if (canvas) {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
        }
    });

    const colors = ["#e21b3c", "#1368ce", "#d89e00", "#26890c", "#ff6b81", "#70a1ff", "#2ed573", "#ffa502"];
    const particles = [];
    const count = 120;

    for (let i = 0; i < count; i++) {
        particles.push({
            x: Math.random() * width,
            y: Math.random() * height - height,
            size: Math.random() * 8 + 6,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: Math.random() * 4 + 3,
            rot: Math.random() * 360,
            vRot: (Math.random() - 0.5) * 10,
            shape: Math.random() > 0.5 ? 'rect' : 'circle'
        });
    }

    let startTime = performance.now();
    let animId = null;

    function render(currentTime) {
        let elapsed = (currentTime - startTime) / 1000;
        ctx.clearRect(0, 0, width, height);

        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.vRot;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;

            if (p.shape === 'rect') {
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();

            if (p.y > height) {
                p.y = -20;
                p.x = Math.random() * width;
            }
        });

        if (elapsed < durationSeconds) {
            animId = requestAnimationFrame(render);
        } else {
            ctx.clearRect(0, 0, width, height);
            if (canvas && canvas.parentNode) {
                canvas.parentNode.removeChild(canvas);
            }
        }
    }

    animId = requestAnimationFrame(render);
}

window.launchConfetti = launchConfetti;
