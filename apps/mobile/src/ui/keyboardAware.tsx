import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Gap left between a revealed input and the top edge of the keyboard. */
const REVEAL_MARGIN = 16;

type Reveal = (target: View | null) => void;

const RevealContext = createContext<Reveal | null>(null);

const noReveal: Reveal = () => {};

/**
 * Callback that scrolls the passed view clear of the keyboard.
 *
 * Outside a `KeyboardAwareScrollView` it is a no-op, so inputs may call it
 * unconditionally.
 */
export function useKeyboardReveal(): Reveal {
  return useContext(RevealContext) ?? noReveal;
}

/**
 * Scrolling container that keeps the focused input above the keyboard.
 *
 * `KeyboardAvoidingView` cannot be used: Android runs edge-to-edge, where
 * `adjustResize` no longer shrinks the window, so the frame math that view
 * relies on yields no offset. The keyboard height is therefore taken straight
 * from the keyboard events and applied as bottom padding, which also shrinks
 * the scroll viewport; the focused input is then scrolled into that viewport.
 *
 * Android reports a keyboard height that excludes the navigation bar, while
 * iOS reports one that covers the home indicator — hence the inset subtraction
 * on iOS only, so that both platforms end up with the same visible gap.
 */
export function KeyboardAwareScrollView({
  children,
  style,
  contentStyle,
  keyboardDismissMode,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Applied to the measured content wrapper, not to the scroll view itself. */
  contentStyle?: StyleProp<ViewStyle>;
  keyboardDismissMode?: "none" | "on-drag" | "interactive";
}) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const targetRef = useRef<View | null>(null);
  const offsetRef = useRef(0);
  const viewportRef = useRef(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const revealTarget = useCallback(() => {
    const target = targetRef.current;
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!target || !content || viewport <= 0) return;

    target.measureLayout(
      content,
      (_x, y, _width, height) => {
        const offset = offsetRef.current;
        const below = y + height + REVEAL_MARGIN - (offset + viewport);
        const above = offset - (y - REVEAL_MARGIN);
        const next =
          below > 0 ? offset + below : above > 0 ? y - REVEAL_MARGIN : null;
        if (next === null) return;
        scrollRef.current?.scrollTo({ y: Math.max(next, 0), animated: true });
      },
      () => {
        // The input unmounted between focus and measurement; nothing to reveal.
      },
    );
  }, []);

  const reveal = useCallback<Reveal>(
    (target) => {
      targetRef.current = target;
      // On first focus the keyboard has not shrunk the viewport yet; the layout
      // handler below runs the same reveal once it has.
      requestAnimationFrame(revealTarget);
    },
    [revealTarget],
  );

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const subscriptions = [
      Keyboard.addListener(showEvent, (event) => {
        setKeyboardHeight(event.endCoordinates.height);
      }),
      Keyboard.addListener(hideEvent, () => {
        setKeyboardHeight(0);
        targetRef.current = null;
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  function onLayout(event: LayoutChangeEvent) {
    const next = event.nativeEvent.layout.height;
    if (next === viewportRef.current) return;
    viewportRef.current = next;
    if (targetRef.current) requestAnimationFrame(revealTarget);
  }

  function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    offsetRef.current = event.nativeEvent.contentOffset.y;
  }

  const padding =
    Platform.OS === "ios"
      ? Math.max(keyboardHeight - insets.bottom, 0)
      : keyboardHeight;

  return (
    <View style={[styles.flex, { paddingBottom: padding }]}>
      <RevealContext.Provider value={reveal}>
        <ScrollView
          ref={scrollRef}
          style={style}
          contentContainerStyle={styles.grow}
          onLayout={onLayout}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={keyboardDismissMode}
        >
          <View ref={contentRef} style={[styles.grow, contentStyle]}>
            {children}
          </View>
        </ScrollView>
      </RevealContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
});
