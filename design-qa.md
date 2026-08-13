# 左侧栏垂直间距 · Design QA

- source visual truth: `/var/folders/cf/c082_8h14sgcvsl6y3crhklm0000gn/T/codex-clipboard-053e6175-990d-4592-ba78-9896070ca6f2.png`
- implementation screenshot: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe4a6-5882-7972-ab21-4ed4edb737d3/sidebar-spacing-implementation.png`
- full-view comparison: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe4a6-5882-7972-ab21-4ed4edb737d3/sidebar-spacing-comparison.png`
- focused comparison: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe4a6-5882-7972-ab21-4ed4edb737d3/sidebar-spacing-focus-comparison.png`
- source pixels: `2560 × 1602`
- implementation pixels: `1280 × 801`
- CSS viewport: `1280 × 801`
- density normalization: the source was downsampled to `1280 × 801`; the focused source sidebar was cropped at `286 × 1602` and normalized to the implementation sidebar's `184 × 801` size for direct vertical-spacing comparison.
- state: family-tree workspace with the relationship research panel open; full project navigation, AI tools, and settings links visible.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: unchanged; the existing logo lockup, project label, navigation labels, and footer labels retain their established families, sizes, weights, and truncation behavior.
- Spacing and layout rhythm: the excessive gap between the brand lockup and “当前项目” is removed. The settings link now ends at `779.4px` inside an `801px` viewport, leaving about `21.6px` of visible bottom clearance.
- Colors and visual tokens: unchanged; the sidebar keeps the existing dark-green surface, active-state fill, dividers, muted labels, and orange issue badge.
- Image quality and asset fidelity: the existing Branchloom app icon is used directly and remains sharp; all navigation icons remain from the existing Tabler icon set.
- Copy and content: unchanged; project and navigation wording remain intact.
- Responsiveness and accessibility: no horizontal overflow was introduced (`scrollWidth === clientWidth === 1280`). All links remain visible, named, and keyboard reachable at the target viewport.

## Open Questions

- None. The requested change is isolated to the vertical gap and does not alter navigation structure or behavior.

## Comparison History

1. The source identified a P2 persistent-navigation issue: excessive brand-to-project spacing pushed the bottom “设置” link partly outside the visible window. Fixed by reducing the brand's bottom padding from `2rem` to `.9rem` and removing the project's top margin. Post-fix evidence: `sidebar-spacing-comparison.png` and `sidebar-spacing-focus-comparison.png`.

## Primary Checks

- Opened the family-tree workspace at `1280 × 801`.
- Confirmed the project switcher and every navigation group remain visible.
- Confirmed the complete settings link is above the viewport bottom.
- Confirmed no horizontal overflow.
- Confirmed browser console errors: `0`.
- Confirmed typecheck and all `414` unit tests pass.

## Implementation Checklist

- [x] Shorten only the brand-to-project empty space.
- [x] Keep the logo, project switcher, navigation order, and footer unchanged.
- [x] Keep “设置” fully visible at the target height.
- [x] Verify typecheck, unit tests, rendered layout, and console state.

## Follow-up Polish

- None required for this scoped adjustment.

final result: passed

---

# 项目基础框架与协作同步迁移 · Design QA

- source visual truth: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe67d-3ffd-7320-a2df-e0e5bd9d26f0/branchloom-page-shell-source.jpg`
- implementation screenshot: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe67d-3ffd-7320-a2df-e0e5bd9d26f0/branchloom-collaboration-shell-implementation.jpg`
- full-view comparison: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe67d-3ffd-7320-a2df-e0e5bd9d26f0/branchloom-shell-comparison.png`
- focused comparison: `/Users/bytedance/.codex/visualizations/2026/08/09/019fe67d-3ffd-7320-a2df-e0e5bd9d26f0/branchloom-shell-topbar-comparison.png`
- source pixels: `862 × 907`
- implementation pixels: `862 × 907`
- CSS viewport: `862 × 907`
- device pixel ratio: `2`; the in-app browser normalized both captures to one output pixel per CSS pixel, so no additional density scaling was applied.
- state: browser development preview using the demo project; the project overview supplies the established shared-shell reference and the collaboration page supplies the migrated implementation state.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: the shared topbar retains the established button type, weight, icon size, and label wrapping behavior; collaboration headings continue using the existing heading and body tokens.
- Spacing and layout rhythm: both pages render the topbar at `x=64`, `y=0`, `width=798`, and `height=60`. The workspace grid is `60px 847px`, and collaboration content remains centered inside the management-page padding.
- Colors and visual tokens: the topbar surface, border, background grid, buttons, semantic panels, and active navigation treatment continue using existing tokens.
- Image quality and asset fidelity: the existing Branchloom app icon is reused directly; all visible action and navigation icons remain from the existing Tabler icon set. No replacement or generated assets were introduced.
- Copy and content: “刷新资料”, “协作同步”, “连接设置”, browser-only safety messaging, tabs, and automatic-sync status remain unchanged.
- Responsiveness and accessibility: no horizontal overflow was introduced (`scrollWidth === clientWidth === 862`). The topbar, refresh control, selected collaboration navigation item, page heading, tabs, and main landmarks remain visibly and semantically available.

## Full-view Comparison Evidence

The source and implementation use the same viewport, navigation shell, theme, and demo project. The comparison shows the collaboration page now starts below the same persistent topbar as project overview, while retaining its management-page content width and hierarchy.

## Focused Region Comparison Evidence

The focused topbar comparison confirms matching height, border position, right inset, refresh-button size, icon, label, and white-space treatment. This crop was necessary because the requested fidelity target is the shared shell rather than the two pages' intentionally different body content.

## Open Questions

- None. The collaboration page remains a primary sidebar destination and intentionally has no back button.

## Comparison History

- No P0, P1, or P2 iteration was required after the first rendered comparison. The migrated page matched the established shell without additional visual fixes.

## Primary Checks

- Opened project overview and collaboration sync at `862 × 907`.
- Confirmed “刷新资料” is visible and returns to its enabled state after activation.
- Switched between “待处理” and “最近同步” and confirmed the selected tab returns correctly.
- Confirmed the main region owns scrolling and the document has no horizontal overflow.
- Confirmed browser console warnings and errors: `0`.
- Confirmed typecheck and all `420` unit tests pass.

## Implementation Checklist

- [x] Make the shared project topbar unconditional.
- [x] Replace page-level shell bypasses with typed content modes.
- [x] Migrate collaboration sync to the management content mode.
- [x] Keep collaboration business behavior and safety boundaries unchanged.
- [x] Add regression coverage for future project routes.
- [x] Verify the rendered shell, primary interactions, responsive width, and console state.

## Follow-up Polish

- None required for this scoped migration.

final result: passed
