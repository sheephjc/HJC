let huAnimationFrame = null;

export function startHuParticles(typeList = [], flowerCount = 0) {
    const canvas = document.getElementById('hu-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    let particles = [];

    function createParticle(color) {
        return {
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 6 + 2,
            dx: (Math.random() - 0.5) * 4,
            dy: (Math.random() - 0.5) * 4,
            alpha: 1,
            color
        };
    }

    function getColor() {
        if (typeList.includes('三金倒')) return 'gold';
        if (typeList.includes('天胡') || typeList.includes('地胡')) return 'red';
        if (typeList.includes('抢杠胡')) return 'violet';
        if (flowerCount >= 5) return '#2196f3';
        return 'white';
    }

    const color = getColor();
    for (let i = 0; i < 120; i += 1) {
        particles.push(createParticle(color));
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach((p) => {
            ctx.globalAlpha = p.alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();

            p.x += p.dx;
            p.y += p.dy;
            p.alpha -= 0.01;
        });

        particles = particles.filter((p) => p.alpha > 0);
        if (particles.length > 0) {
            huAnimationFrame = requestAnimationFrame(animate);
        }
    }

    animate();
}

export function stopHuParticles() {
    if (huAnimationFrame) cancelAnimationFrame(huAnimationFrame);
}
