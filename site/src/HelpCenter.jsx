import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, BookOpen, BriefcaseBusiness, ChevronRight, CircleHelp, GraduationCap, HardHat, House, Image, PlayCircle, Route, Search, Settings2, ShieldCheck, Star, X } from 'lucide-react';
import { HELP_GUIDES } from './helpGuides.js';
import './help-center.css';

const icons = { start:GraduationCap, orders:BriefcaseBusiness, engineers:HardHat, map:Route, rating:Star, reviews:ShieldCheck, preview:Settings2 };
export function HelpCenter({ profile, onClose, onNavigate }) {
  const [tab,setTab]=useState('home'), [guideId,setGuideId]=useState(null), [query,setQuery]=useState(''), [image,setImage]=useState(null);
  const bodyRef=useRef(null), imageCloseRef=useRef(null);
  const guide=HELP_GUIDES.find(item=>item.id===guideId);
  const firstName=profile.name.trim().split(/\s+/)[0]||'коллега';
  const open=id=>{setGuideId(id);bodyRef.current?.scrollTo({top:0});};
  const changeTab=id=>{setTab(id);setGuideId(null);bodyRef.current?.scrollTo({top:0});};
  useEffect(()=>{
    if(!image)return;
    const previous=document.activeElement;imageCloseRef.current?.focus();
    const close=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setImage(null);}};
    document.addEventListener('keydown',close,true);
    return()=>{document.removeEventListener('keydown',close,true);if(previous?.isConnected)previous.focus();};
  },[image]);
  const found=HELP_GUIDES.filter(item=>[item.title,item.description,...item.steps.flat()].join(' ').toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')));
  const cards=items=><div className="help-guide-cards">{items.map((item,index)=>{const Icon=icons[item.id];return <button type="button" key={item.id} onClick={()=>open(item.id)}><span className="help-guide-icon"><Icon size={22}/></span><span><b>{item.title}</b><small>{item.description}</small><em>{tab==='learn'?`Урок ${index+1} · `:''}{item.steps.length} шагов{item.video?' · видео':''}</em></span><ChevronRight size={18}/></button>;})}</div>;
  return <><aside className="help-center help-guide-center" role="dialog" aria-label="Центр помощи BeeGo!"><header><div className="help-brand"><img src="/beego-mark.png" alt=""/><span><b>BeeGo!</b><small>Помощь в работе</small></span></div><button type="button" onClick={onClose} aria-label="Закрыть помощь"><X/></button></header>
    <div ref={bodyRef} className="help-center-body">
      {guide?<article className="help-guide-article"><button className="help-guide-back" type="button" onClick={()=>setGuideId(null)}><ArrowLeft size={17}/>К инструкциям</button><span className="help-guide-eyebrow">Пошаговая инструкция</span><h2>{guide.title}</h2><p className="help-guide-intro">{guide.description}</p>
        <button className="help-guide-image" type="button" onClick={()=>setImage(guide)} aria-label={`Увеличить скриншот: ${guide.title}`}><img src={`/help/${guide.image}.jpg`} alt={`Экран BeeGo!: ${guide.title}`} loading="lazy"/><span><Image size={15}/>Посмотреть крупнее</span></button>
        {guide.video?<section className="help-guide-video"><h3><PlayCircle size={19}/>Короткий показ действий</h3><video controls preload="none" playsInline poster="/help/orders.jpg" aria-label="Видео: маршрут, заявка и режимы карты"><source src="/help/workspace-tour.webm" type="video/webm"/><track default kind="captions" src="/help/workspace-tour.vtt" srcLang="ru" label="Русский"/>Ваш браузер не поддерживает видео.</video><p>Открываем маршрут и заявку, затем переключаем метки времени, тепловую карту и оформление. Без звука, с подписями.</p></section>:null}
        <ol className="help-guide-steps">{guide.steps.map(([title,text],index)=><li key={title}><span>{index+1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
        {guide.note?<div className="help-guide-note"><ShieldCheck size={19}/><p>{guide.note}</p></div>:null}
        <button type="button" className="help-guide-open" onClick={()=>onNavigate?.(guide.section,guide.tab)}>{guide.action}<ArrowRight size={18}/></button>
      </article>:<>
        {tab==='home'?<section className="help-view help-guide-home"><div className="help-welcome"><img src="/mascot-empty-routes.png" alt=""/><div><small>Всегда рядом</small><h2>Привет, {firstName}!</h2><p>Короткие инструкции для работы с BeeGo! — с экранами и примерами действий.</p></div></div><button type="button" className="help-guide-feature" onClick={()=>open('start')}><span className="help-guide-feature-image"><img src="/help/orders.jpg" alt="Пример выбранной заявки на маршруте"/><i><PlayCircle size={32}/></i></span><span><em>Быстрый старт · видео и 5 шагов</em><b>Первый рабочий день</b><small>Выберите день, проверьте данные и откройте маршрут.</small></span><ArrowRight size={19}/></button><h3 className="help-guide-section-title"><BookOpen size={18}/>Частые задачи</h3>{cards(HELP_GUIDES.filter(item=>['orders','map','rating','reviews'].includes(item.id)))}</section>:null}
        {tab==='learn'?<section className="help-view"><div className="help-page-title compact"><span><GraduationCap/></span><div><small>Справочник по интерфейсу</small><h2>Работаем по шагам</h2><p>Каждая инструкция — с настоящим экраном сайта.</p></div></div>{cards(HELP_GUIDES)}</section>:null}
        {tab==='help'?<section className="help-view"><div className="help-page-title compact"><span><CircleHelp/></span><div><small>База знаний</small><h2>Найдём ответ</h2></div></div><label className="help-search"><Search/><input aria-label="Поиск инструкции" placeholder="Маршрут, рейтинг, импорт…" value={query} onChange={event=>setQuery(event.target.value)}/>{query?<button type="button" aria-label="Очистить поиск инструкций" onClick={()=>setQuery('')}><X size={16}/></button>:null}</label>{found.length?cards(found):<div className="help-guide-empty"><Search size={26}/><b>Инструкция не найдена</b><p>Попробуйте «заявка», «рейтинг», «карта» или очистите поиск.</p><button type="button" onClick={()=>setQuery('')}>Все инструкции</button></div>}</section>:null}
      </>}
    </div><nav className="help-tabs" aria-label="Разделы помощи">{[['home',House,'Главная'],['learn',GraduationCap,'Обучение'],['help',CircleHelp,'Помощь']].map(([id,Icon,label])=><button type="button" key={id} className={tab===id?'active':''} onClick={()=>changeTab(id)} aria-current={tab===id?'page':undefined}><Icon/><span>{label}</span></button>)}</nav>
  </aside>{image?createPortal(<div className="help-image-viewer" onMouseDown={event=>{if(event.target===event.currentTarget)setImage(null);}}><section role="dialog" aria-modal="true" aria-label={`Скриншот: ${image.title}`}><header><b>{image.title}</b><button type="button" ref={imageCloseRef} onClick={()=>setImage(null)} aria-label="Закрыть скриншот"><X/></button></header><img src={`/help/${image.image}.jpg`} alt={`Экран BeeGo!: ${image.title}`}/><p>Экран рабочего интерфейса. Данные и выбранная дата на вашем экране могут отличаться.</p></section></div>,document.querySelector('.app-shell')||document.body):null}</>;
}
