// invert-image — one-shot CLI that produces a cream-on-transparent
// version of a dark-ink-on-transparent PNG (or vice versa), matching
// what CSS's `filter: invert(1) hue-rotate(180deg)` does in the
// browser.
//
// Used to derive the lighter app-icon source from
// client/src-tauri/icons/source.png so the regenerated Tauri icon
// set has the cream cookie+house on a transparent background, like
// the web login screen.
//
//   go run ./tools/invert-image <in.png> <out.png>
//
// invert(1) flips each RGB channel: r' = 255 - r. hue-rotate(180deg)
// then shifts the hue by 180° in YIQ space — equivalent to negating
// the I and Q components while keeping luma Y. For grayscale and
// near-grayscale ink the combined effect is "light becomes dark, dark
// becomes light, hue preserved". We implement it via HSL: flip the
// lightness component, keep hue and saturation.

package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
)

func main() {
	if len(os.Args) != 3 {
		log.Fatalf("usage: %s <in.png> <out.png>", os.Args[0])
	}
	inPath, outPath := os.Args[1], os.Args[2]

	f, err := os.Open(inPath)
	if err != nil {
		log.Fatalf("open %s: %v", inPath, err)
	}
	src, err := png.Decode(f)
	_ = f.Close()
	if err != nil {
		log.Fatalf("decode %s: %v", inPath, err)
	}

	b := src.Bounds()
	dst := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := src.At(x, y).RGBA()
			// RGBA returns 16-bit channel values; collapse to 8-bit
			// for our HSL math.
			r8 := float64(uint8(r>>8)) / 255.0
			g8 := float64(uint8(g>>8)) / 255.0
			b8 := float64(uint8(bl>>8)) / 255.0
			a8 := uint8(a >> 8)

			h, s, l := rgbToHSL(r8, g8, b8)
			l = 1.0 - l
			nr, ng, nb := hslToRGB(h, s, l)
			dst.SetNRGBA(x, y, color.NRGBA{
				R: uint8(math.Round(nr * 255)),
				G: uint8(math.Round(ng * 255)),
				B: uint8(math.Round(nb * 255)),
				A: a8,
			})
		}
	}

	out, err := os.Create(outPath)
	if err != nil {
		log.Fatalf("create %s: %v", outPath, err)
	}
	defer out.Close()
	if err := png.Encode(out, dst); err != nil {
		log.Fatalf("encode %s: %v", outPath, err)
	}
	log.Printf("inverted lightness of %s -> %s", inPath, outPath)
}

// rgbToHSL converts 0..1 RGB to 0..1 HSL.
func rgbToHSL(r, g, b float64) (h, s, l float64) {
	max := math.Max(r, math.Max(g, b))
	min := math.Min(r, math.Min(g, b))
	l = (max + min) / 2

	d := max - min
	if d == 0 {
		return 0, 0, l
	}
	if l > 0.5 {
		s = d / (2 - max - min)
	} else {
		s = d / (max + min)
	}
	switch max {
	case r:
		h = (g - b) / d
		if g < b {
			h += 6
		}
	case g:
		h = (b-r)/d + 2
	case b:
		h = (r-g)/d + 4
	}
	h /= 6
	return
}

// hslToRGB converts 0..1 HSL back to 0..1 RGB.
func hslToRGB(h, s, l float64) (r, g, b float64) {
	if s == 0 {
		return l, l, l
	}
	var q float64
	if l < 0.5 {
		q = l * (1 + s)
	} else {
		q = l + s - l*s
	}
	p := 2*l - q
	r = hueToRGB(p, q, h+1.0/3.0)
	g = hueToRGB(p, q, h)
	b = hueToRGB(p, q, h-1.0/3.0)
	return
}

func hueToRGB(p, q, t float64) float64 {
	if t < 0 {
		t += 1
	}
	if t > 1 {
		t -= 1
	}
	if t < 1.0/6.0 {
		return p + (q-p)*6*t
	}
	if t < 1.0/2.0 {
		return q
	}
	if t < 2.0/3.0 {
		return p + (q-p)*(2.0/3.0-t)*6
	}
	return p
}
