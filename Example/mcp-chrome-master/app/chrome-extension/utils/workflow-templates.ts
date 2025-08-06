/**
 * Pre-built workflow templates for common automation scenarios
 */

import { WorkflowTemplate } from 'chrome-mcp-shared';

export const DEFAULT_TEMPLATES: WorkflowTemplate[] = [
  {
    name: 'ecommerce_product_purchase',
    description: 'Complete e-commerce product purchase workflow with error handling',
    category: 'ecommerce',
    tags: ['shopping', 'purchase', 'automation', 'ecommerce'],
    workflow: {
      name: 'E-commerce Product Purchase',
      description: 'Automated product purchase workflow with cart management and checkout',
      variables: {
        product_url: '',
        quantity: 1,
        shipping_address: {},
        payment_method: 'saved_card'
      },
      errorHandling: {
        strategy: 'rollback_on_error',
        rollbackSteps: ['clear_cart', 'return_to_homepage']
      },
      steps: [
        {
          id: 'navigate_to_product',
          tool: 'chrome_navigate',
          args: {
            url: '{{product_url}}'
          },
          onError: 'retry',
          retryCount: 2,
          waitFor: {
            type: 'element',
            selector: '.product-details, [data-testid="product-page"]',
            state: 'visible',
            timeout: 10000
          }
        },
        {
          id: 'verify_product_availability',
          tool: 'chrome_get_web_content',
          args: {
            selector: '.availability, .stock-status, [data-testid="availability"]'
          },
          depends: ['navigate_to_product'],
          condition: '{{product_url}} !== ""'
        },
        {
          id: 'set_quantity',
          tool: 'chrome_fill_or_select',
          args: {
            selector: 'input[name="quantity"], select[name="qty"], #quantity',
            value: '{{quantity}}'
          },
          depends: ['verify_product_availability'],
          onError: 'continue'
        },
        {
          id: 'add_to_cart',
          tool: 'chrome_click_element',
          args: {
            selector: '.add-to-cart, [data-testid="add-to-cart"], button:contains("Add to Cart")'
          },
          depends: ['set_quantity'],
          onError: 'retry',
          retryCount: 3,
          waitFor: {
            type: 'element',
            selector: '.cart-confirmation, .added-to-cart, [data-testid="cart-updated"]',
            state: 'visible',
            timeout: 5000
          }
        },
        {
          id: 'go_to_cart',
          tool: 'chrome_click_element',
          args: {
            selector: '.cart-link, [data-testid="cart"], a[href*="cart"]'
          },
          depends: ['add_to_cart'],
          waitFor: {
            type: 'navigation',
            url: 'cart',
            timeout: 10000
          }
        },
        {
          id: 'proceed_to_checkout',
          tool: 'chrome_click_element',
          args: {
            selector: '.checkout-btn, [data-testid="checkout"], button:contains("Checkout")'
          },
          depends: ['go_to_cart'],
          waitFor: {
            type: 'navigation',
            url: 'checkout',
            timeout: 10000
          }
        },
        {
          id: 'fill_shipping_info',
          tool: 'chrome_workflow_execute',
          args: {
            workflow: {
              name: 'Fill Shipping Form',
              steps: [
                {
                  id: 'fill_address',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: '#shipping-address-1, input[name="address1"]',
                    value: '{{shipping_address.street}}'
                  }
                },
                {
                  id: 'fill_city',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: '#city, input[name="city"]',
                    value: '{{shipping_address.city}}'
                  }
                },
                {
                  id: 'fill_zipcode',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: '#zip, input[name="zipcode"], input[name="postal_code"]',
                    value: '{{shipping_address.zip}}'
                  }
                }
              ]
            }
          },
          depends: ['proceed_to_checkout'],
          condition: '{{shipping_address.street}} !== ""'
        },
        {
          id: 'select_payment_method',
          tool: 'chrome_click_element',
          args: {
            selector: '[data-payment="{{payment_method}}"], input[value="{{payment_method}}"]'
          },
          depends: ['fill_shipping_info']
        },
        {
          id: 'review_order',
          tool: 'chrome_screenshot',
          args: {
            name: 'order_review',
            storeBase64: true,
            selector: '.order-review, .order-summary'
          },
          depends: ['select_payment_method']
        },
        {
          id: 'place_order',
          tool: 'chrome_click_element',
          args: {
            selector: '.place-order, [data-testid="place-order"], button:contains("Place Order")'
          },
          depends: ['review_order'],
          waitFor: {
            type: 'element',
            selector: '.order-confirmation, .thank-you, [data-testid="order-success"]',
            state: 'visible',
            timeout: 30000
          }
        },
        {
          id: 'capture_confirmation',
          tool: 'chrome_screenshot',
          args: {
            name: 'order_confirmation',
            storeBase64: true,
            fullPage: true
          },
          depends: ['place_order']
        }
      ]
    },
    createdAt: new Date().toISOString()
  },

  {
    name: 'data_collection_pipeline',
    description: 'Automated data collection from multiple sources with transformation',
    category: 'data_collection',
    tags: ['scraping', 'data', 'automation', 'analysis'],
    workflow: {
      name: 'Data Collection Pipeline',
      description: 'Collect data from multiple pages, transform, and save results',
      variables: {
        target_urls: [],
        selectors: {
          title: 'h1, .title, [data-testid="title"]',
          price: '.price, .cost, [data-testid="price"]',
          description: '.description, .summary'
        },
        output_format: 'json'
      },
      steps: [
        {
          id: 'initialize_data_collection',
          tool: 'chrome_get_windows_and_tabs',
          args: {}
        },
        {
          id: 'collect_from_urls',
          tool: 'chrome_workflow_execute',
          args: {
            workflow: {
              name: 'URL Collection Loop',
              steps: [
                {
                  id: 'navigate_to_url',
                  tool: 'chrome_navigate',
                  args: {
                    url: '{{current_url}}'
                  },
                  waitFor: {
                    type: 'page_load',
                    timeout: 15000
                  }
                },
                {
                  id: 'extract_data',
                  tool: 'chrome_get_web_content',
                  args: {
                    textContent: true
                  },
                  depends: ['navigate_to_url']
                },
                {
                  id: 'capture_screenshot',
                  tool: 'chrome_screenshot',
                  args: {
                    storeBase64: true,
                    fullPage: false,
                    width: 1200,
                    height: 800
                  },
                  depends: ['extract_data']
                }
              ]
            }
          },
          depends: ['initialize_data_collection']
        },
        {
          id: 'compile_results',
          tool: 'chrome_get_web_content',
          args: {
            selector: 'body',
            textContent: true
          },
          depends: ['collect_from_urls']
        }
      ]
    },
    createdAt: new Date().toISOString()
  },

  {
    name: 'form_automation_suite',
    description: 'Automated form filling with validation and error handling',
    category: 'forms',
    tags: ['forms', 'automation', 'validation', 'data_entry'],
    workflow: {
      name: 'Form Automation Suite',
      description: 'Detect and fill forms automatically with validation',
      variables: {
        form_data: {
          personal: {
            first_name: '',
            last_name: '',
            email: '',
            phone: ''
          },
          address: {
            street: '',
            city: '',
            state: '',
            zip: ''
          }
        },
        validate_before_submit: true
      },
      steps: [
        {
          id: 'detect_forms',
          tool: 'chrome_get_interactive_elements',
          args: {
            selector: 'form'
          }
        },
        {
          id: 'analyze_form_structure',
          tool: 'chrome_inject_script',
          args: {
            type: 'ISOLATED',
            jsScript: `
              const forms = document.querySelectorAll('form');
              const formData = [];
              forms.forEach(form => {
                const fields = [];
                form.querySelectorAll('input, select, textarea').forEach(field => {
                  fields.push({
                    type: field.type,
                    name: field.name,
                    id: field.id,
                    required: field.required,
                    placeholder: field.placeholder
                  });
                });
                formData.push({ fields });
              });
              return JSON.stringify(formData);
            `
          },
          depends: ['detect_forms']
        },
        {
          id: 'fill_personal_info',
          tool: 'chrome_workflow_execute',
          args: {
            workflow: {
              name: 'Fill Personal Information',
              steps: [
                {
                  id: 'fill_first_name',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: 'input[name*="first"], input[id*="first"], #firstName',
                    value: '{{form_data.personal.first_name}}'
                  },
                  onError: 'continue'
                },
                {
                  id: 'fill_last_name',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: 'input[name*="last"], input[id*="last"], #lastName',
                    value: '{{form_data.personal.last_name}}'
                  },
                  onError: 'continue'
                },
                {
                  id: 'fill_email',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: 'input[type="email"], input[name*="email"], #email',
                    value: '{{form_data.personal.email}}'
                  },
                  onError: 'continue'
                },
                {
                  id: 'fill_phone',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: 'input[type="tel"], input[name*="phone"], #phone',
                    value: '{{form_data.personal.phone}}'
                  },
                  onError: 'continue'
                }
              ]
            }
          },
          depends: ['analyze_form_structure'],
          condition: '{{form_data.personal.first_name}} !== ""'
        },
        {
          id: 'validate_form',
          tool: 'chrome_inject_script',
          args: {
            type: 'ISOLATED',
            jsScript: `
              const form = document.querySelector('form');
              if (!form) return JSON.stringify({valid: false, error: 'No form found'});
              
              const requiredFields = form.querySelectorAll('input[required], select[required], textarea[required]');
              const emptyRequired = [];
              
              requiredFields.forEach(field => {
                if (!field.value.trim()) {
                  emptyRequired.push(field.name || field.id || field.placeholder);
                }
              });
              
              return JSON.stringify({
                valid: emptyRequired.length === 0,
                emptyRequired: emptyRequired
              });
            `
          },
          depends: ['fill_personal_info'],
          condition: '{{validate_before_submit}} === true'
        },
        {
          id: 'submit_form',
          tool: 'chrome_click_element',
          args: {
            selector: 'button[type="submit"], input[type="submit"], .submit-btn'
          },
          depends: ['validate_form'],
          waitFor: {
            type: 'navigation',
            timeout: 10000
          }
        },
        {
          id: 'capture_result',
          tool: 'chrome_screenshot',
          args: {
            name: 'form_submission_result',
            storeBase64: true
          },
          depends: ['submit_form']
        }
      ]
    },
    createdAt: new Date().toISOString()
  },

  {
    name: 'testing_user_journey',
    description: 'Automated user journey testing with validation and reporting',
    category: 'testing',
    tags: ['testing', 'qa', 'user_journey', 'validation'],
    workflow: {
      name: 'User Journey Testing',
      description: 'Complete user journey test with checkpoints and validation',
      variables: {
        base_url: '',
        test_user: {
          username: 'testuser@example.com',
          password: 'testpass123'
        },
        expected_elements: [],
        test_report: []
      },
      steps: [
        {
          id: 'start_test_session',
          tool: 'chrome_navigate',
          args: {
            url: '{{base_url}}',
            newWindow: true
          },
          waitFor: {
            type: 'page_load',
            timeout: 10000
          }
        },
        {
          id: 'capture_homepage',
          tool: 'chrome_screenshot',
          args: {
            name: 'homepage_initial',
            storeBase64: true
          },
          depends: ['start_test_session']
        },
        {
          id: 'test_login_flow',
          tool: 'chrome_workflow_execute',
          args: {
            workflow: {
              name: 'Login Test',
              steps: [
                {
                  id: 'click_login_button',
                  tool: 'chrome_click_element',
                  args: {
                    selector: '.login-btn, #login, a:contains("Login"), button:contains("Login")'
                  },
                  waitFor: {
                    type: 'element',
                    selector: 'input[type="email"], input[name="username"], #username',
                    state: 'visible',
                    timeout: 5000
                  }
                },
                {
                  id: 'fill_username',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: 'input[type="email"], input[name="username"], #username',
                    value: '{{test_user.username}}'
                  },
                  depends: ['click_login_button']
                },
                {
                  id: 'fill_password',
                  tool: 'chrome_fill_or_select',
                  args: {
                    selector: 'input[type="password"], input[name="password"], #password',
                    value: '{{test_user.password}}'
                  },
                  depends: ['fill_username']
                },
                {
                  id: 'submit_login',
                  tool: 'chrome_click_element',
                  args: {
                    selector: 'button[type="submit"], .login-submit, #login-submit'
                  },
                  depends: ['fill_password'],
                  waitFor: {
                    type: 'navigation',
                    timeout: 10000
                  }
                }
              ]
            }
          },
          depends: ['capture_homepage']
        },
        {
          id: 'validate_login_success',
          tool: 'chrome_wait_for_condition',
          args: {
            condition: {
              type: 'element_state',
              selector: '.user-menu, .dashboard, .profile-icon, [data-testid="logged-in"]',
              state: 'visible',
              timeout: 10000
            }
          },
          depends: ['test_login_flow']
        },
        {
          id: 'test_main_functionality',
          tool: 'chrome_get_interactive_elements',
          args: {
            includeCoordinates: true
          },
          depends: ['validate_login_success']
        },
        {
          id: 'capture_logged_in_state',
          tool: 'chrome_screenshot',
          args: {
            name: 'logged_in_dashboard',
            storeBase64: true
          },
          depends: ['test_main_functionality']
        },
        {
          id: 'test_logout',
          tool: 'chrome_click_element',
          args: {
            selector: '.logout, .sign-out, a:contains("Logout"), button:contains("Logout")'
          },
          depends: ['capture_logged_in_state'],
          waitFor: {
            type: 'navigation',
            timeout: 5000
          }
        },
        {
          id: 'validate_logout_success',
          tool: 'chrome_wait_for_condition',
          args: {
            condition: {
              type: 'element_state',
              selector: '.login-btn, #login, a:contains("Login")',
              state: 'visible',
              timeout: 5000
            }
          },
          depends: ['test_logout']
        },
        {
          id: 'generate_test_report',
          tool: 'chrome_screenshot',
          args: {
            name: 'test_completion',
            storeBase64: true
          },
          depends: ['validate_logout_success']
        }
      ]
    },
    createdAt: new Date().toISOString()
  }
];

/**
 * Initialize default templates in storage
 */
export async function initializeDefaultTemplates(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(['workflow_templates']);
    const existingTemplates = result.workflow_templates || {};
    
    // Add default templates if they don't exist
    let hasNewTemplates = false;
    
    for (const template of DEFAULT_TEMPLATES) {
      if (!existingTemplates[template.name]) {
        existingTemplates[template.name] = template;
        hasNewTemplates = true;
      }
    }
    
    if (hasNewTemplates) {
      await chrome.storage.local.set({ workflow_templates: existingTemplates });
      console.log('Default workflow templates initialized');
    }
    
  } catch (error) {
    console.error('Error initializing default templates:', error);
  }
}