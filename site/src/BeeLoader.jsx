import './bee-loader.css';

export function BeeLoadingScene() {
  return <div className="bee-loader-scene" aria-hidden="true"><span className="bee-loader-glow"/><img src="/beego-mark.png" alt=""/><span className="bee-loader-trail"/></div>;
}

export function BeeLoader({ title = 'Загружаем объекты', description = 'Готовим адреса и время визитов' }) {
  return <div className="bee-object-loader" role="status" aria-live="polite"><BeeLoadingScene/><b>{title}</b><span>{description}</span></div>;
}
