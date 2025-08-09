// common/automation-templates.js
// Predefined automation workflows for common tasks

/**
 * Task Template Library for Autonomous Browser Control
 * These templates provide structured workflows for common user tasks
 */

class AutomationTemplates {
  
  /**
   * E-commerce automation templates
   */
  static getEcommerceTemplates() {
    return {
      productResearch: {
        id: 'product-research',
        name: 'Product Research & Comparison',
        description: 'Research products across multiple sites and compare features, prices, reviews',
        settings: {
          maxSteps: 30,
          autoScreenshots: true,
          timeoutMs: 8000
        },
        sites: ['amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'bestbuy.com'],
        workflow: [
          'Navigate to each major shopping site',
          'Search for the specified product',
          'Extract product details, prices, and ratings',
          'Compare shipping options and availability',
          'Compile comprehensive comparison report'
        ]
      },
      
      priceTracking: {
        id: 'price-tracking',
        name: 'Multi-Site Price Tracking',
        description: 'Track prices across multiple retailers and find best deals',
        settings: {
          maxSteps: 25,
          autoScreenshots: false,
          timeoutMs: 6000
        },
        workflow: [
          'Visit price comparison sites (Google Shopping, PriceGrabber)',
          'Check individual retailer websites',
          'Note current prices and any active promotions',
          'Identify lowest price and best overall value'
        ]
      },
      
      cartManagement: {
        id: 'cart-management',
        name: 'Shopping Cart Operations',
        description: 'Add items to cart, manage quantities, apply coupons',
        settings: {
          maxSteps: 20,
          autoScreenshots: true,
          timeoutMs: 7000
        },
        workflow: [
          'Navigate to product pages',
          'Select size, color, quantity options',
          'Add items to shopping cart',
          'Apply discount codes or coupons',
          'Review cart contents and totals'
        ]
      }
    };
  }
  
  /**
   * Social media automation templates
   */
  static getSocialMediaTemplates() {
    return {
      contentPosting: {
        id: 'content-posting',
        name: 'Cross-Platform Content Publishing',
        description: 'Post content across multiple social media platforms',
        settings: {
          maxSteps: 25,
          autoScreenshots: true,
          timeoutMs: 8000
        },
        platforms: ['twitter.com', 'linkedin.com', 'facebook.com', 'instagram.com'],
        workflow: [
          'Navigate to each social media platform',
          'Compose and format posts appropriately for each platform',
          'Add images or media attachments if specified',
          'Schedule posts or publish immediately',
          'Monitor initial engagement metrics'
        ]
      },
      
      socialListening: {
        id: 'social-listening',
        name: 'Social Media Monitoring',
        description: 'Monitor mentions, hashtags, and engagement across platforms',
        settings: {
          maxSteps: 20,
          autoScreenshots: false,
          timeoutMs: 6000
        },
        workflow: [
          'Search for specified keywords or hashtags',
          'Monitor brand mentions across platforms',
          'Track engagement metrics and sentiment',
          'Compile monitoring report with key insights'
        ]
      }
    };
  }
  
  /**
   * Research and information gathering templates
   */
  static getResearchTemplates() {
    return {
      academicResearch: {
        id: 'academic-research',
        name: 'Academic Research & Citation Gathering',
        description: 'Research academic topics and gather citations from multiple sources',
        settings: {
          maxSteps: 35,
          autoScreenshots: true,
          timeoutMs: 10000
        },
        sources: ['scholar.google.com', 'jstor.org', 'pubmed.ncbi.nlm.nih.gov', 'arxiv.org'],
        workflow: [
          'Search academic databases for relevant papers',
          'Extract abstracts and key findings',
          'Gather proper citation information',
          'Cross-reference findings across sources',
          'Compile comprehensive research summary'
        ]
      },
      
      marketResearch: {
        id: 'market-research',
        name: 'Market Research & Competitive Analysis',
        description: 'Research market trends and analyze competitors',
        settings: {
          maxSteps: 30,
          autoScreenshots: true,
          timeoutMs: 8000
        },
        sources: ['statista.com', 'ibisworld.com', 'crunchbase.com', 'similarweb.com'],
        workflow: [
          'Research industry trends and market size',
          'Analyze competitor websites and offerings',
          'Gather pricing and positioning information',
          'Extract key statistics and data points',
          'Compile competitive landscape report'
        ]
      },
      
      newsAggregation: {
        id: 'news-aggregation',
        name: 'News Research & Aggregation',
        description: 'Gather news and updates on specific topics from multiple sources',
        settings: {
          maxSteps: 25,
          autoScreenshots: false,
          timeoutMs: 6000
        },
        sources: ['reuters.com', 'ap.org', 'bbc.com', 'bloomberg.com'],
        workflow: [
          'Search for latest news on specified topics',
          'Filter for credible and recent sources',
          'Extract key headlines and summaries',
          'Identify trending themes and developments',
          'Create consolidated news briefing'
        ]
      }
    };
  }
  
  /**
   * Productivity and workflow automation templates
   */
  static getProductivityTemplates() {
    return {
      emailManagement: {
        id: 'email-management',
        name: 'Email Organization & Management',
        description: 'Organize inbox, categorize emails, and handle routine responses',
        settings: {
          maxSteps: 20,
          autoScreenshots: false,
          timeoutMs: 5000
        },
        workflow: [
          'Access email inbox (Gmail, Outlook, etc.)',
          'Categorize emails by priority and type',
          'Archive or delete unnecessary messages',
          'Flag important items for follow-up',
          'Draft responses to routine inquiries'
        ]
      },
      
      dataCollection: {
        id: 'data-collection',
        name: 'Web Data Collection & Extraction',
        description: 'Extract structured data from websites and compile into reports',
        settings: {
          maxSteps: 25,
          autoScreenshots: true,
          timeoutMs: 7000
        },
        workflow: [
          'Navigate to target websites and pages',
          'Extract relevant data fields and content',
          'Handle pagination and multiple result pages',
          'Validate and clean extracted data',
          'Format data for export or analysis'
        ]
      },
      
      formFilling: {
        id: 'form-filling',
        name: 'Automated Form Completion',
        description: 'Fill out forms and applications with provided information',
        settings: {
          maxSteps: 15,
          autoScreenshots: true,
          timeoutMs: 6000
        },
        workflow: [
          'Navigate to form or application page',
          'Fill personal and contact information fields',
          'Handle file uploads and document attachments',
          'Complete multi-step form wizards',
          'Review and submit completed forms'
        ]
      }
    };
  }
  
  /**
   * Entertainment and media templates
   */
  static getMediaTemplates() {
    return {
      playlistManagement: {
        id: 'playlist-management',  
        name: 'Music Playlist Creation & Management',
        description: 'Create and manage playlists across music streaming platforms',
        settings: {
          maxSteps: 20,
          autoScreenshots: false,
          timeoutMs: 6000
        },
        platforms: ['spotify.com', 'youtube.com/music', 'music.apple.com'],
        workflow: [
          'Navigate to music streaming platform',
          'Search for specified songs or artists',
          'Create new playlist or modify existing one',
          'Add songs and organize track order',
          'Configure playlist settings and sharing options'
        ]
      },
      
      videoResearch: {
        id: 'video-research',
        name: 'Video Content Research & Curation',
        description: 'Find and curate video content on specific topics',
        settings: {
          maxSteps: 18,
          autoScreenshots: true,
          timeoutMs: 7000
        },
        platforms: ['youtube.com', 'vimeo.com', 'dailymotion.com'],
        workflow: [
          'Search for videos on specified topics',
          'Filter by quality, duration, and relevance',
          'Extract video metadata and descriptions',
          'Create curated list of recommended content',
          'Generate summary of key video insights'
        ]
      }
    };
  }
  
  /**
   * Get template by ID from any category
   */
  static getTemplateById(templateId) {
    const allTemplates = {
      ...this.getEcommerceTemplates(),
      ...this.getSocialMediaTemplates(),
      ...this.getResearchTemplates(),
      ...this.getProductivityTemplates(),
      ...this.getMediaTemplates()
    };
    
    return allTemplates[templateId] || null;
  }
  
  /**
   * Get all templates organized by category
   */
  static getAllTemplates() {
    return {
      ecommerce: this.getEcommerceTemplates(),
      socialMedia: this.getSocialMediaTemplates(),
      research: this.getResearchTemplates(),
      productivity: this.getProductivityTemplates(),
      media: this.getMediaTemplates()
    };
  }
  
  /**
   * Get template suggestions based on user query
   */
  static suggestTemplates(query) {
    const lowerQuery = query.toLowerCase();
    const suggestions = [];
    
    // E-commerce keywords
    if (/shop|buy|purchase|price|product|compare|cart|checkout/.test(lowerQuery)) {
      suggestions.push(...Object.values(this.getEcommerceTemplates()));
    }
    
    // Social media keywords
    if (/post|social|twitter|facebook|linkedin|instagram|share/.test(lowerQuery)) {
      suggestions.push(...Object.values(this.getSocialMediaTemplates()));
    }
    
    // Research keywords
    if (/research|study|analyze|investigate|report|data|academic/.test(lowerQuery)) {
      suggestions.push(...Object.values(this.getResearchTemplates()));
    }
    
    // Productivity keywords
    if (/email|form|organize|manage|collect|extract/.test(lowerQuery)) {
      suggestions.push(...Object.values(this.getProductivityTemplates()));
    }
    
    // Media keywords
    if (/video|music|playlist|youtube|spotify|watch|listen/.test(lowerQuery)) {
      suggestions.push(...Object.values(this.getMediaTemplates()));
    }
    
    return suggestions.slice(0, 3); // Return top 3 suggestions
  }
  
  /**
   * Create a custom goal string from template
   */
  static createGoalFromTemplate(template, userParams = {}) {
    const baseGoal = `Execute ${template.name}: ${template.description}`;
    
    if (userParams.query) {
      return `${baseGoal} Focus on: "${userParams.query}"`;
    }
    
    if (userParams.product) {
      return `${baseGoal} Target product: "${userParams.product}"`;
    }
    
    if (userParams.topic) {
      return `${baseGoal} Research topic: "${userParams.topic}"`;
    }
    
    if (userParams.content) {
      return `${baseGoal} Content: "${userParams.content}"`;
    }
    
    return baseGoal;
  }
}

// Export for use in different environments
if (typeof window !== 'undefined') {
  // Browser window context (sidepanel)
  window.AutomationTemplates = AutomationTemplates;
} else if (typeof globalThis !== 'undefined') {
  // Service worker context (background script)
  globalThis.AutomationTemplates = AutomationTemplates;
} else if (typeof global !== 'undefined') {
  // Node.js context
  global.AutomationTemplates = AutomationTemplates;
}

// For Node.js module compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutomationTemplates;
}