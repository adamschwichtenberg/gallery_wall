import { useEffect } from 'preact/hooks';
import { Icon } from './components/Icon';
import { ArrangeScreen } from './screens/Arrange';
import { FrameEditor } from './screens/FrameEditor';
import { FramesScreen, PicturesScreen } from './screens/Inventory';
import { PictureEditor } from './screens/PictureEditor';
import { ProjectsScreen, SettingsModal } from './screens/Projects';
import { WallEditor } from './screens/WallEditor';
import { VantageEditor } from './screens/VantageEditor';
import { SurfaceEditor } from './screens/SurfaceEditor';
import { navigate, openModal, useStore } from './lib/store';

export function App() {
  const ready = useStore((s) => s.ready);
  const route = useStore((s) => s.route);
  const modal = useStore((s) => s.modal);
  const toast = useStore((s) => s.toast);
  const reduce = useStore((s) => s.prefs.reduceTransparency);

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-transparency', reduce);
  }, [reduce]);

  if (!ready) return <div class="busy"><div class="spinner" /></div>;

  const tab = route.name === 'project' ? 'projects' : route.name;
  return (
    <>
      {route.name === 'project' ? (
        <ArrangeScreen id={route.id} />
      ) : (
        <>
          {route.name === 'projects' && <ProjectsScreen />}
          {route.name === 'frames' && <FramesScreen />}
          {route.name === 'pictures' && <PicturesScreen />}
          <nav class="topnav glass" style={{ borderRadius: 999, padding: 4 }}>
            <div class="segmented">
              <button class={tab === 'projects' ? 'on' : ''} onClick={() => navigate({ name: 'projects' })}><Icon name="wall" size={18} /><span class="lbl">Walls</span></button>
              <button class={tab === 'frames' ? 'on' : ''} data-testid="tab-frames" onClick={() => navigate({ name: 'frames' })}><Icon name="frame" size={18} /><span class="lbl">Frames</span></button>
              <button class={tab === 'pictures' ? 'on' : ''} data-testid="tab-pictures" onClick={() => navigate({ name: 'pictures' })}><Icon name="picture" size={18} /><span class="lbl">Pictures</span></button>
            </div>
          </nav>
          <div class="corner-actions">
            <button class="btn icon-only glass" aria-label="Settings" onClick={() => openModal({ kind: 'settings' })}><Icon name="settings" /></button>
          </div>
        </>
      )}
      {modal?.kind === 'frame' && <FrameEditor id={modal.id} key={modal.id ?? 'new'} />}
      {modal?.kind === 'picture' && <PictureEditor id={modal.id} key={modal.id ?? 'new'} />}
      {modal?.kind === 'wall' && <WallEditor projectId={modal.projectId} />}
      {modal?.kind === 'vantage' && <VantageEditor projectId={modal.projectId} id={modal.id} key={modal.id ?? 'new'} />}
      {modal?.kind === 'surface' && <SurfaceEditor projectId={modal.projectId} id={modal.id} key={modal.id} />}
      {modal?.kind === 'settings' && <SettingsModal />}
      {toast && <div class="toast glass strong" key={toast.id}>{toast.text}</div>}
    </>
  );
}
