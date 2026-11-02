import React from 'react';
import BilingualTranslatorView from './components/BilingualTranslatorView';
import { autoPrepareAudioAndMic } from './utils/audioStreamManager';

const App: React.FC = () => {
  // Pre-warm audio and mic on any initial interaction across the app
  const handleUserGesture = () => {
    autoPrepareAudioAndMic();
  };

  return (
    <main 
      onClick={handleUserGesture}
      onTouchStart={handleUserGesture}
      className="w-full h-full h-screen h-dvh flex flex-col overflow-hidden border-4 sm:border-[6px] border-amber-500 bg-white box-border text-stone-800"
    >
      {/* Main Page Container (100% Full Width & Height) */}
      <div className="w-full flex-1 flex flex-col min-h-0 overflow-hidden box-border">
        <BilingualTranslatorView />
      </div>
    </main>
  );
};

export default App;
