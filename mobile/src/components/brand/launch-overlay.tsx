import { useEffect, useState } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/theme/theme";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

/*
 * The launch, told in two beats on the native splash's navy field:
 *   1. Lockup: the tile settles and "linkPay Business" slides out from behind it.
 *   2. Crossing: the lime leaves the tile for the bridge, and the camera passes under the arch,
 *      whose opening is a window onto the first screen.
 * Everything is drawn as vectors in screen space every frame, so the bridge stays sharp at any size.
 */

// The bridge, in its own units (web/scripts/brand-assets.ts MARK_PATH, viewBox 0 0 374 144).
const MARK_W = 374;
const MARK_CY = 72;
const ARCH_X = 187;
// The point under the arch the camera aims for: low in the opening, so its edges clear the screen soonest.
const AIM_Y = 105;
// The tile around the mark, in mark units (the mark spans 0.58 of the tile, corners 0.3 of it).
const TILE_UNITS = MARK_W / 0.58;
const TILE_RADIUS = 0.3;

// The native splash (app.json: imageWidth 88, tile at 800/1024 of the image). Frame one matches it exactly.
const SPLASH_TILE = (88 * 800) / 1024;
// Size of the tile in the lockup, and the gap before the wordmark.
const LOCKUP_TILE = 60;
const GAP = 14;

// Colours baked into splash-icon.png by brand-assets.ts. The overlay must match those pixels, not the
// app's `pop` token (a hair darker), or the hand-off from the native splash would show.
const SPLASH_LIME = "#a8e600";
const SPLASH_INK = "#132b41";

// Timeline (ms after the overlay mounts, which is when the native splash starts fading out over it).
const HOLD = 200;
const SETTLE = 650;
const WORDS_IN_AT = 300;
const WORDS_IN = 600;
const CROSS_AT = 1120;
const CROSS = 680;

const easeOut = Easing.out(Easing.exp);
const easeInOut = Easing.inOut(Easing.cubic);

const clamp01 = (v: number) => {
  "worklet";
  return Math.min(1, Math.max(0, v));
};

/** Where the plane sits this frame: the screen point of the aim, and points per mark unit. */
type Plane = { ax: number; ay: number; ppu: number };

function plane(settle: number, cross: number, labelW: number, W: number, H: number): Plane {
  "worklet";
  // Beat 1: the tile shrinks a touch and moves left so tile and wordmark sit centred together.
  const tile = SPLASH_TILE + (LOCKUP_TILE - SPLASH_TILE) * settle;
  const ppuLockup = tile / TILE_UNITS;
  const cx = W / 2 - (labelW / 2) * settle;
  const lockAx = cx;
  const lockAy = H / 2 + (AIM_Y - MARK_CY) * ppuLockup;
  // Beat 2: the camera turns to the arch and moves through it. Scale is interpolated in log space so the
  // approach feels like constant forward motion, accelerating (ease-in) as it passes under.
  // The opening covers the screen at a third of the end scale (about 90% through), so the last frames
  // are already the app and the closing fade has nothing left to show.
  const ppuEnd = (3 * (H / 2 + 60)) / (144 - AIM_Y);
  const z = cross * cross;
  const ppu = ppuLockup * Math.exp(Math.log(ppuEnd / ppuLockup) * z);
  const m = easeInOut(clamp01(cross / 0.7));
  return { ax: lockAx + (W / 2 - lockAx) * m, ay: lockAy + (H / 2 - lockAy) * m, ppu };
}

function bridgePath(p: Plane, closeArchOnly: boolean) {
  "worklet";
  const x = (u: number) => (p.ax + (u - ARCH_X) * p.ppu).toFixed(2);
  const y = (u: number) => (p.ay + (u - AIM_Y) * p.ppu).toFixed(2);
  const arch =
    `${x(345.6)} ${y(144)}C${x(332.9)} ${y(97.7)} ${x(291)} ${y(26)} ${x(187)} ${y(26)}` +
    `C${x(83)} ${y(26)} ${x(41.1)} ${y(97.7)} ${x(28.4)} ${y(144)}`;
  if (closeArchOnly) return `M${arch}Z`;
  return `M${x(0)} ${y(0)}H${x(374)}V${y(144)}L${arch}H${x(0)}Z`;
}

let played = false;

/**
 * Takes over from the native splash (pixel for pixel), plays once per launch, then unmounts.
 * Never touchable; the app is already rendered underneath.
 */
export function LaunchOverlay() {
  const reduceMotion = useReducedMotion();
  const { colors } = useTheme();
  const { width: W, height: H } = useWindowDimensions();
  const [done, setDone] = useState(played);

  const settle = useSharedValue(0);
  const words = useSharedValue(0);
  const cross = useSharedValue(0);
  const fade = useSharedValue(1);
  const labelW = useSharedValue(0);
  const labelH = useSharedValue(0);

  useEffect(() => {
    if (played) return;
    played = true;
    const finish = () => setDone(true);
    if (reduceMotion) {
      fade.set(withDelay(HOLD, withTiming(0, { duration: 240 }, () => scheduleOnRN(finish))));
      return;
    }
    settle.set(withDelay(HOLD, withSpring(1, { dampingRatio: 0.78, duration: SETTLE })));
    words.set(withDelay(WORDS_IN_AT, withTiming(1, { duration: WORDS_IN, easing: easeOut })));
    cross.set(
      withDelay(
        CROSS_AT,
        withTiming(1, { duration: CROSS, easing: Easing.linear }, (finished) => {
          if (finished) scheduleOnRN(finish);
        }),
      ),
    );
  }, [reduceMotion, settle, words, cross, fade]);

  const root = useAnimatedStyle(() => ({ opacity: fade.get() * (1 - clamp01((cross.get() - 0.92) / 0.08)) }));

  const fieldProps = useAnimatedProps(() => {
    const p = plane(settle.get(), cross.get(), labelW.get(), W, H);
    return { d: `M0 0H${W}V${H}H0Z${bridgePath(p, true)}` };
  });

  const tileProps = useAnimatedProps(() => {
    const p = plane(settle.get(), cross.get(), labelW.get(), W, H);
    const size = TILE_UNITS * p.ppu;
    return {
      x: p.ax - size / 2,
      y: p.ay + (MARK_CY - AIM_Y) * p.ppu - size / 2,
      width: size,
      height: size,
      rx: size * TILE_RADIUS,
      ry: size * TILE_RADIUS,
      // The lime leaves the tile in the first third of the crossing.
      fillOpacity: 1 - easeOut(clamp01(cross.get() / 0.35)),
    };
  });

  const bridgeProps = useAnimatedProps(() => {
    const p = plane(settle.get(), cross.get(), labelW.get(), W, H);
    return {
      d: bridgePath(p, false),
      fill: interpolateColor(easeOut(clamp01(cross.get() / 0.35)), [0, 1], [SPLASH_INK, SPLASH_LIME]),
    };
  });

  // The wordmark rides on the tile's right edge and slides out from behind it.
  const label = useAnimatedStyle(() => {
    const p = plane(settle.get(), cross.get(), labelW.get(), W, H);
    const tileHalf = (TILE_UNITS * p.ppu) / 2;
    const tileCy = p.ay + (MARK_CY - AIM_Y) * p.ppu;
    return {
      opacity: words.get() > 0 ? 1 : 0,
      transform: [{ translateX: p.ax + tileHalf }, { translateY: tileCy - labelH.get() / 2 }],
    };
  });
  const wordmark = useAnimatedStyle(() => {
    const w = words.get();
    const out = clamp01(cross.get() / 0.22);
    return {
      opacity: Math.min(1, w * 1.4) * (1 - out),
      transform: [{ translateX: -(1 - w) * (labelW.get() * 0.55) }],
    };
  });

  if (done) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, root]}
    >
      <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
        <AnimatedPath fill={colors.band} fillRule="evenodd" animatedProps={fieldProps} />
        <AnimatedRect fill={SPLASH_LIME} animatedProps={tileProps} />
        <AnimatedPath animatedProps={bridgeProps} />
      </Svg>
      <Wordmark style={label} innerStyle={wordmark} width={labelW} height={labelH} />
    </Animated.View>
  );
}

function Wordmark({
  style,
  innerStyle,
  width,
  height,
}: {
  style: ReturnType<typeof useAnimatedStyle>;
  innerStyle: ReturnType<typeof useAnimatedStyle>;
  width: SharedValue<number>;
  height: SharedValue<number>;
}) {
  return (
    <Animated.View style={[styles.label, style]}>
      <View
        style={styles.clip}
        onLayout={(e) => {
          width.set(e.nativeEvent.layout.width);
          height.set(e.nativeEvent.layout.height);
        }}
      >
        <Animated.View style={innerStyle}>
          <Text numberOfLines={1} maxFontSizeMultiplier={1.15} style={styles.linkPay} className="text-band-foreground">
            linkPay
            <Text style={styles.business} className="text-band-muted">
              {" "}
              Business
            </Text>
          </Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  label: { position: "absolute", left: 0, top: 0 },
  // The left edge of this clip is the tile's right edge, so the name appears to come out from behind it.
  clip: { overflow: "hidden", paddingLeft: GAP },
  linkPay: { fontFamily: "BricolageDisplay-SemiBold", fontSize: 28, lineHeight: 34, letterSpacing: -0.6 },
  business: { fontFamily: "BricolageDisplay-Medium" },
});
