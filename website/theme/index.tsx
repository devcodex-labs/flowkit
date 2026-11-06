import { Layout as DefaultLayout, DocContent, Search } from '@rspress/core/theme-original';
import { withBase, ThemeContext } from '@rspress/core/runtime';
import { useContext } from 'react';
import './style.css';
export * from '@rspress/core/theme-original';
export function SwitchAppearance({ onClick }: { onClick?: () => void }) {
  const { theme, setTheme } = useContext(ThemeContext);
  return <button type="button" className="rp-switch-appearance flowkit-theme-switch" aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} aria-pressed={theme === 'dark'} onClick={() => { setTheme?.(theme === 'dark' ? 'light' : 'dark'); onClick?.(); }}>{theme === 'dark' ? '☾' : '☀'}</button>;
}
export function Layout() { return <DefaultLayout afterFeatures={<section className="flowkit-home-content rp-doc rspress-doc"><DocContent components={undefined} /></section>} />; }
export function NotFoundLayout() { return <main className="flowkit-home-content rp-doc"><h1>页面未找到</h1><p>检查地址，或使用搜索按钮查找任务、API 和错误码。</p><div className="flowkit-not-found-search"><Search /></div><p><a href={withBase('/')}>回到首页</a> · <a href={withBase('/guide/quick-start.html')}>快速开始</a> · <a href={withBase('/guide/installation.html')}>安装与环境</a></p></main>; }
