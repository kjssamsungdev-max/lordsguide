<?php
/**
 * Plugin Name: LordsGuide — Daily Verse & Prayer
 * Plugin URI: https://lordsguide.com
 * Description: Display a beautiful daily Bible verse, prayer wall embed, and sermon tools from LordsGuide on your church website. Includes widgets and shortcodes.
 * Version: 1.0.0
 * Author: LordsGuide / Artisans F&B Corp
 * Author URI: https://lordsguide.com
 * License: MIT
 * Text Domain: lordsguide
 */

defined('ABSPATH') || exit;

// ── Daily Verse Data ──
function lordsguide_get_daily_verse() {
    $verses = array(
        array('text' => 'For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.', 'ref' => 'Jeremiah 29:11'),
        array('text' => 'I can do all things through Christ which strengtheneth me.', 'ref' => 'Philippians 4:13'),
        array('text' => 'The Lord is my shepherd; I shall not want.', 'ref' => 'Psalm 23:1'),
        array('text' => 'Trust in the Lord with all thine heart; and lean not unto thine own understanding.', 'ref' => 'Proverbs 3:5'),
        array('text' => 'Be strong and of a good courage; be not afraid, neither be thou dismayed: for the Lord thy God is with thee whithersoever thou goest.', 'ref' => 'Joshua 1:9'),
        array('text' => 'But they that wait upon the Lord shall renew their strength; they shall mount up with wings as eagles.', 'ref' => 'Isaiah 40:31'),
        array('text' => 'And we know that all things work together for good to them that love God.', 'ref' => 'Romans 8:28'),
        array('text' => 'The Lord is my light and my salvation; whom shall I fear?', 'ref' => 'Psalm 27:1'),
        array('text' => 'Fear thou not; for I am with thee: be not dismayed; for I am thy God.', 'ref' => 'Isaiah 41:10'),
        array('text' => 'Come unto me, all ye that labour and are heavy laden, and I will give you rest.', 'ref' => 'Matthew 11:28'),
        array('text' => 'The joy of the Lord is your strength.', 'ref' => 'Nehemiah 8:10'),
        array('text' => 'He leadeth me beside the still waters. He restoreth my soul.', 'ref' => 'Psalm 23:2-3'),
        array('text' => 'Be still, and know that I am God.', 'ref' => 'Psalm 46:10'),
        array('text' => 'My grace is sufficient for thee: for my strength is made perfect in weakness.', 'ref' => '2 Corinthians 12:9'),
        array('text' => 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.', 'ref' => 'John 3:16'),
        array('text' => 'Casting all your care upon him; for he careth for you.', 'ref' => '1 Peter 5:7'),
        array('text' => 'Draw nigh to God, and he will draw nigh to you.', 'ref' => 'James 4:8'),
        array('text' => 'The name of the Lord is a strong tower: the righteous runneth into it, and is safe.', 'ref' => 'Proverbs 18:10'),
    );
    $day = date('z');
    return $verses[$day % count($verses)];
}

// ── Shortcode: [lordsguide_verse] ──
function lordsguide_verse_shortcode($atts) {
    $atts = shortcode_atts(array('style' => 'card'), $atts);
    $verse = lordsguide_get_daily_verse();
    
    $html = '<div class="lordsguide-verse" style="background:#faf8f4;border:1px solid #e8e0d4;border-radius:14px;padding:24px;text-align:center;font-family:Georgia,serif;max-width:500px;margin:16px auto;box-shadow:0 2px 8px rgba(0,0,0,0.04);">';
    $html .= '<div style="font-size:10px;color:#8b6914;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-family:-apple-system,sans-serif;font-weight:600;">✝ Today\'s Word for You</div>';
    $html .= '<p style="font-size:18px;font-style:italic;color:#2d2416;line-height:1.8;margin:0 0 10px;">"' . esc_html($verse['text']) . '"</p>';
    $html .= '<span style="font-size:12px;color:#8b6914;font-family:-apple-system,sans-serif;">— ' . esc_html($verse['ref']) . ' KJV</span>';
    $html .= '<div style="margin-top:14px;"><a href="https://lordsguide.com?utm_source=wordpress&utm_medium=plugin" target="_blank" rel="noopener" style="font-size:11px;color:#8a7e6e;text-decoration:none;font-family:-apple-system,sans-serif;">Powered by LordsGuide</a></div>';
    $html .= '</div>';
    
    return $html;
}
add_shortcode('lordsguide_verse', 'lordsguide_verse_shortcode');

// ── Shortcode: [lordsguide_app] — Full app embed ──
function lordsguide_app_shortcode($atts) {
    $atts = shortcode_atts(array('height' => '600'), $atts);
    $height = intval($atts['height']);
    return '<div class="lordsguide-embed" style="border-radius:14px;overflow:hidden;border:1px solid #e8e0d4;box-shadow:0 2px 12px rgba(0,0,0,0.06);"><iframe src="https://lordsguide.com" width="100%" height="' . $height . '" style="border:none;" title="LordsGuide" loading="lazy"></iframe></div>';
}
add_shortcode('lordsguide_app', 'lordsguide_app_shortcode');

// ── Shortcode: [lordsguide_prayer] — Prayer wall embed ──
function lordsguide_prayer_shortcode($atts) {
    return '<div class="lordsguide-prayer" style="text-align:center;padding:20px;background:#faf8f4;border-radius:14px;border:1px solid #e8e0d4;">'
        . '<p style="font-size:16px;color:#2d2416;margin:0 0 12px;font-family:Georgia,serif;">🙏 Community Prayer Wall</p>'
        . '<a href="https://lordsguide.com?utm_source=wordpress&screen=community" target="_blank" rel="noopener" style="display:inline-block;padding:10px 20px;background:#8b6914;color:#fff;border-radius:10px;text-decoration:none;font-size:13px;font-weight:600;">Join the Prayer Wall</a>'
        . '<p style="font-size:10px;color:#8a7e6e;margin-top:10px;">Powered by LordsGuide</p>'
        . '</div>';
}
add_shortcode('lordsguide_prayer', 'lordsguide_prayer_shortcode');

// ── WordPress Widget Class ──
class LordsGuide_Verse_Widget extends WP_Widget {
    public function __construct() {
        parent::__construct('lordsguide_verse', 'LordsGuide Daily Verse', array(
            'description' => 'Displays a beautiful daily Bible verse from LordsGuide.',
        ));
    }

    public function widget($args, $instance) {
        echo $args['before_widget'];
        echo do_shortcode('[lordsguide_verse]');
        echo $args['after_widget'];
    }

    public function form($instance) {
        echo '<p>This widget displays today\'s Bible verse from LordsGuide. It updates automatically every day.</p>';
        echo '<p><a href="https://lordsguide.com" target="_blank">Visit LordsGuide</a></p>';
    }
}

function lordsguide_register_widgets() {
    register_widget('LordsGuide_Verse_Widget');
}
add_action('widgets_init', 'lordsguide_register_widgets');

// ── Admin notice on activation ──
function lordsguide_activation_notice() {
    if (get_transient('lordsguide_activated')) {
        echo '<div class="notice notice-success is-dismissible">';
        echo '<p><strong>LordsGuide</strong> is active! Use <code>[lordsguide_verse]</code> in any post or page, or add the "LordsGuide Daily Verse" widget to your sidebar. <a href="https://lordsguide.com" target="_blank">Learn more</a></p>';
        echo '</div>';
        delete_transient('lordsguide_activated');
    }
}
add_action('admin_notices', 'lordsguide_activation_notice');

function lordsguide_activate() {
    set_transient('lordsguide_activated', true, 60);
}
register_activation_hook(__FILE__, 'lordsguide_activate');
