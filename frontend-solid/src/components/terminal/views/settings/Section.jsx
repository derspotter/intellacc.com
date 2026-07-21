// Engineering-panel module: hairline box, header strip with a sheet code.
// Sections pack into a masonry column grid so no screen width is wasted.
export default function Section(props) {
  const danger = props.tone === 'danger';
  return (
    <div
      class={`break-inside-avoid mb-px border bg-bb-bg ${
        danger ? 'border-market-down/60' : 'border-bb-border'
      }`}
    >
      <div
        class={`px-2 py-1 flex items-baseline justify-between bg-bb-panel font-bold uppercase text-xs border-b ${
          danger ? 'border-market-down/60 text-market-down' : 'border-bb-border text-bb-accent'
        }`}
      >
        <span>[{props.title}]</span>
        <span class="text-bb-muted font-normal text-[10px] tracking-widest">{props.code}</span>
      </div>
      <div class="p-2">
        {props.children}
      </div>
    </div>
  );
}
