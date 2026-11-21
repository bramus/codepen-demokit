// Alternative Versions:
// - JS ScrollTimeline 2022: https://codepen.io/bramus/pen/MWVExQg
// - CSS view-timeline 2022: https://codepen.io/bramus/pen/GRdGoKy/ 👈 = The version you are currently looking at
// - JS Motion One: https://codepen.io/bramus/pen/PoRKEaZ
// - CSS @scroll-timeline 2021 (Old Syntax): https://codepen.io/bramus/pen/xxRZZdK
// - JS ScrollTimeline 2021 (Old Syntax): https://codepen.io/bramus/pen/PobZbBV

// The JS below is so you can click and drag to scroll on desktop
// @source https://codepen.io/thenutz/pen/VwYeYEE
const slider = document.querySelector(".cards");
let isDown = false;
let startX;
let scrollLeft;

slider.addEventListener("pointerdown", (e) => {
	isDown = true;
	slider.classList.add("active");
	startX = e.pageX - slider.offsetLeft;
	scrollLeft = slider.scrollLeft;
});
slider.addEventListener("pointerleave", () => {
	isDown = false;
	slider.classList.remove("active");
});
slider.addEventListener("pointerup", () => {
	isDown = false;
	slider.classList.remove("active");
});
slider.addEventListener("pointermove", (e) => {
	if (!isDown) return;
	e.preventDefault();
	const x = e.pageX - slider.offsetLeft;
	const walk = (x - startX) * 3; //scroll-fast
	slider.scrollLeft = scrollLeft - walk;
});
