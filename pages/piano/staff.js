const canvas = document.getElementById('staff');
const ctx = canvas.getContext('2d');

const STAFF_TOP = 50;       // 五线谱顶部位置
const LINE_SPACING = 30;    // 五线间距
const NOTE_SPACING = 30;    // 每个音符水平间距
const STAFF_LEFT_MARGIN = 50;

let noteIndex = 0;          // 当前绘制音符的横向位置

// MIDI -> 高音谱号 C4 为基准（MIDI 60）
function midiToStaffY(midi) {
    // 高音谱号线从 E4 (MIDI 64) 开始，线间距 LINE_SPACING/2 计算
    // 线为 E4 G4 B4 D5 F5 (bottom->top)
    const E4_MIDI = 64;
    const y = STAFF_TOP + (E4_MIDI - midi) * (LINE_SPACING / 2);
    return y;
}

// 绘制五线谱
export function drawStaff() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;

    for (let i = 0; i < 5; i++) {
        const y = STAFF_TOP + i * LINE_SPACING;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }

}

// 绘制音符
export function drawNote(midi) {
    const x = STAFF_LEFT_MARGIN + noteIndex * NOTE_SPACING;
    const y = midiToStaffY(midi);

    // 画实心椭圆
    ctx.beginPath();
    ctx.ellipse(x, y, 7, 5, 0, 0, 2 * Math.PI);
    ctx.fillStyle = 'black';
    ctx.fill();

    // 画音符杆（如果在谱线下方则向上画，反之向下画）
    const E4_MIDI = 64;
    const stemUp = midi < E4_MIDI;
    const stemHeight = 35;
    ctx.beginPath();
    if (stemUp) {
        ctx.moveTo(x + 7, y);
        ctx.lineTo(x + 7, y - stemHeight);
    } else {
        ctx.moveTo(x - 7, y);
        ctx.lineTo(x - 7, y + stemHeight);
    }
    ctx.stroke();

    noteIndex++;

    // 超出画布时整体左移，实现滚动
    if (STAFF_LEFT_MARGIN + noteIndex * NOTE_SPACING > canvas.width) {
        noteIndex--;
        const imageData = ctx.getImageData(NOTE_SPACING, 0, canvas.width - NOTE_SPACING, canvas.height);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.putImageData(imageData, 0, 0);
    }
}

// 重置五线谱
export function resetStaff() {
    noteIndex = 0;
    drawStaff();
}

// 初始化
drawStaff();
