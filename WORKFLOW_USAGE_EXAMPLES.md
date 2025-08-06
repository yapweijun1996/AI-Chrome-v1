# Workflow Orchestration Usage Examples

This document provides comprehensive examples of how to use the new workflow orchestration features for complex browser automation tasks.

## Basic Workflow Example

### Simple Multi-Step Navigation
```json
{
  "workflow": {
    "name": "basic_navigation_workflow",
    "description": "Navigate to a site, take screenshot, and check elements",
    "variables": {
      "target_url": "https://example.com",
      "screenshot_name": "example_page"
    },
    "steps": [
      {
        "id": "navigate",
        "tool": "chrome_navigate",
        "args": {
          "url": "{{target_url}}"
        },
        "waitFor": {
          "type": "page_load",
          "timeout": 10000
        }
      },
      {
        "id": "screenshot",
        "tool": "chrome_screenshot",
        "args": {
          "name": "{{screenshot_name}}",
          "storeBase64": true,
          "fullPage": true
        },
        "depends": ["navigate"]
      },
      {
        "id": "get_elements",
        "tool": "chrome_get_interactive_elements",
        "args": {
          "includeCoordinates": true
        },
        "depends": ["screenshot"]
      }
    ]
  }
}
```

### With Error Handling and Retries
```json
{
  "workflow": {
    "name": "robust_navigation",
    "description": "Navigation with comprehensive error handling",
    "errorHandling": {
      "strategy": "continue_on_error"
    },
    "steps": [
      {
        "id": "navigate",
        "tool": "chrome_navigate",
        "args": {
          "url": "https://unreliable-site.com"
        },
        "onError": "retry",
        "retryCount": 3,
        "retryDelay": 2000,
        "timeout": 15000
      },
      {
        "id": "wait_for_content",
        "tool": "chrome_wait_for_condition",
        "args": {
          "condition": {
            "type": "element_state",
            "selector": ".main-content",
            "state": "visible",
            "timeout": 10000
          }
        },
        "depends": ["navigate"],
        "onError": "continue"
      }
    ]
  }
}
```

## E-commerce Automation Example

### Complete Purchase Workflow
```json
{
  "workflow": {
    "name": "automated_purchase",
    "description": "Complete e-commerce purchase with validation",
    "variables": {
      "product_url": "https://shop.example.com/product/123",
      "quantity": 2,
      "user_email": "buyer@example.com",
      "shipping_zip": "12345"
    },
    "errorHandling": {
      "strategy": "rollback_on_error",
      "rollbackSteps": ["clear_cart", "logout"]
    },
    "steps": [
      {
        "id": "navigate_to_product",
        "tool": "chrome_navigate",
        "args": {
          "url": "{{product_url}}"
        },
        "waitFor": {
          "type": "element_state",
          "selector": ".product-details, [data-testid='product-page']",
          "state": "visible",
          "timeout": 10000
        }
      },
      {
        "id": "check_availability",
        "tool": "chrome_get_web_content",
        "args": {
          "selector": ".availability, .stock-status",
          "textContent": true
        },
        "depends": ["navigate_to_product"]
      },
      {
        "id": "set_quantity",
        "tool": "chrome_fill_or_select",
        "args": {
          "selector": "input[name='quantity'], select[name='qty']",
          "value": "{{quantity}}"
        },
        "depends": ["check_availability"],
        "onError": "continue"
      },
      {
        "id": "add_to_cart",
        "tool": "chrome_click_element",
        "args": {
          "selector": ".add-to-cart, button:contains('Add to Cart')"
        },
        "depends": ["set_quantity"],
        "onError": "retry",
        "retryCount": 3,
        "waitFor": {
          "type": "element_state",
          "selector": ".cart-confirmation, .added-to-cart",
          "state": "visible",
          "timeout": 5000
        }
      },
      {
        "id": "go_to_cart",
        "tool": "chrome_navigate",
        "args": {
          "url": "https://shop.example.com/cart"
        },
        "depends": ["add_to_cart"]
      },
      {
        "id": "verify_cart_contents",
        "tool": "chrome_get_web_content",
        "args": {
          "selector": ".cart-items",
          "textContent": true
        },
        "depends": ["go_to_cart"]
      },
      {
        "id": "proceed_to_checkout",
        "tool": "chrome_click_element",
        "args": {
          "selector": ".checkout-btn, button:contains('Checkout')"
        },
        "depends": ["verify_cart_contents"],
        "waitFor": {
          "type": "navigation",
          "url": "checkout",
          "timeout": 10000
        }
      },
      {
        "id": "fill_email",
        "tool": "chrome_fill_or_select",
        "args": {
          "selector": "input[type='email'], input[name='email']",
          "value": "{{user_email}}"
        },
        "depends": ["proceed_to_checkout"]
      },
      {
        "id": "fill_shipping_zip",
        "tool": "chrome_fill_or_select",
        "args": {
          "selector": "input[name='zip'], input[name='postal_code']",
          "value": "{{shipping_zip}}"
        },
        "depends": ["fill_email"]
      },
      {
        "id": "capture_order_review",
        "tool": "chrome_screenshot",
        "args": {
          "name": "order_review",
          "storeBase64": true,
          "selector": ".order-summary"
        },
        "depends": ["fill_shipping_zip"]
      },
      {
        "id": "clear_cart",
        "tool": "chrome_click_element",
        "args": {
          "selector": ".clear-cart, .remove-all"
        },
        "onError": "continue"
      },
      {
        "id": "logout",
        "tool": "chrome_click_element",
        "args": {
          "selector": ".logout, .sign-out"
        },
        "onError": "continue"
      }
    ]
  }
}
```

## Data Collection Workflow

### Multi-Site Data Scraping
```json
{
  "workflow": {
    "name": "competitor_price_monitoring",
    "description": "Collect product prices from multiple competitor sites",
    "variables": {
      "product_name": "MacBook Pro",
      "competitor_urls": [
        "https://store1.com/search",
        "https://store2.com/products",
        "https://store3.com/catalog"
      ],
      "results": []
    },
    "steps": [
      {
        "id": "search_store1",
        "tool": "chrome_navigate",
        "args": {
          "url": "https://store1.com/search?q={{product_name}}"
        },
        "waitFor": {
          "type": "element_state",
          "selector": ".search-results",
          "state": "visible",
          "timeout": 10000
        }
      },
      {
        "id": "extract_store1_prices",
        "tool": "chrome_get_web_content",
        "args": {
          "selector": ".product-price, .price",
          "textContent": true
        },
        "depends": ["search_store1"]
      },
      {
        "id": "screenshot_store1",
        "tool": "chrome_screenshot",
        "args": {
          "name": "store1_results",
          "storeBase64": true,
          "selector": ".search-results"
        },
        "depends": ["extract_store1_prices"]
      },
      {
        "id": "search_store2",
        "tool": "chrome_navigate",
        "args": {
          "url": "https://store2.com/products?search={{product_name}}"
        },
        "waitFor": {
          "type": "element_state",
          "selector": ".product-grid",
          "state": "visible",
          "timeout": 10000
        }
      },
      {
        "id": "extract_store2_prices",
        "tool": "chrome_get_web_content",
        "args": {
          "selector": ".product-price, .cost",
          "textContent": true
        },
        "depends": ["search_store2"]
      },
      {
        "id": "compile_results",
        "tool": "chrome_inject_script",
        "args": {
          "type": "ISOLATED",
          "jsScript": "console.log('Data collection completed for {{product_name}}'); return { status: 'completed', timestamp: Date.now() };"
        },
        "depends": ["extract_store1_prices", "extract_store2_prices"]
      }
    ]
  }
}
```

## Form Automation Example

### Multi-Step Form Filling
```json
{
  "workflow": {
    "name": "application_form_automation",
    "description": "Complete multi-page application form",
    "variables": {
      "applicant": {
        "firstName": "John",
        "lastName": "Doe",
        "email": "john.doe@example.com",
        "phone": "555-0123",
        "address": {
          "street": "123 Main St",
          "city": "Anytown",
          "state": "CA",
          "zip": "12345"
        },
        "employment": {
          "company": "Tech Corp",
          "position": "Developer",
          "years": "5"
        }
      }
    },
    "steps": [
      {
        "id": "navigate_to_form",
        "tool": "chrome_navigate",
        "args": {
          "url": "https://example.com/application"
        }
      },
      {
        "id": "fill_personal_info",
        "tool": "chrome_workflow_execute",
        "args": {
          "workflow": {
            "name": "Personal Information Section",
            "steps": [
              {
                "id": "first_name",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "#firstName, input[name='firstName']",
                  "value": "{{applicant.firstName}}"
                }
              },
              {
                "id": "last_name",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "#lastName, input[name='lastName']",
                  "value": "{{applicant.lastName}}"
                }
              },
              {
                "id": "email",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "input[type='email'], input[name='email']",
                  "value": "{{applicant.email}}"
                }
              },
              {
                "id": "phone",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "input[type='tel'], input[name='phone']",
                  "value": "{{applicant.phone}}"
                }
              }
            ]
          }
        },
        "depends": ["navigate_to_form"]
      },
      {
        "id": "next_to_address",
        "tool": "chrome_click_element",
        "args": {
          "selector": ".next-btn, button:contains('Next')"
        },
        "depends": ["fill_personal_info"],
        "waitFor": {
          "type": "element_state",
          "selector": "#address, .address-section",
          "state": "visible",
          "timeout": 5000
        }
      },
      {
        "id": "fill_address",
        "tool": "chrome_workflow_execute",
        "args": {
          "workflow": {
            "name": "Address Section",
            "steps": [
              {
                "id": "street",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "#street, input[name='address']",
                  "value": "{{applicant.address.street}}"
                }
              },
              {
                "id": "city",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "#city, input[name='city']",
                  "value": "{{applicant.address.city}}"
                }
              },
              {
                "id": "state",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "#state, select[name='state']",
                  "value": "{{applicant.address.state}}"
                }
              },
              {
                "id": "zip",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "#zip, input[name='zipCode']",
                  "value": "{{applicant.address.zip}}"
                }
              }
            ]
          }
        },
        "depends": ["next_to_address"]
      },
      {
        "id": "validate_form",
        "tool": "chrome_inject_script",
        "args": {
          "type": "ISOLATED",
          "jsScript": "const form = document.querySelector('form'); const requiredFields = form.querySelectorAll('[required]'); const empty = []; requiredFields.forEach(field => { if (!field.value.trim()) empty.push(field.name || field.id); }); return JSON.stringify({ valid: empty.length === 0, emptyFields: empty });"
        },
        "depends": ["fill_address"]
      },
      {
        "id": "submit_form",
        "tool": "chrome_click_element",
        "args": {
          "selector": "button[type='submit'], .submit-btn"
        },
        "depends": ["validate_form"],
        "condition": "true",
        "waitFor": {
          "type": "element_state",
          "selector": ".success-message, .confirmation",
          "state": "visible",
          "timeout": 10000
        }
      },
      {
        "id": "capture_confirmation",
        "tool": "chrome_screenshot",
        "args": {
          "name": "application_submitted",
          "storeBase64": true,
          "fullPage": true
        },
        "depends": ["submit_form"]
      }
    ]
  }
}
```

## Testing Workflow Example

### Comprehensive User Journey Test
```json
{
  "workflow": {
    "name": "user_journey_test_suite",
    "description": "Complete user journey testing with validation points",
    "variables": {
      "test_user": {
        "username": "testuser@example.com",
        "password": "testpass123"
      },
      "base_url": "https://app.example.com",
      "test_results": []
    },
    "errorHandling": {
      "strategy": "continue_on_error"
    },
    "steps": [
      {
        "id": "start_test",
        "tool": "chrome_navigate",
        "args": {
          "url": "{{base_url}}",
          "newWindow": true
        }
      },
      {
        "id": "capture_homepage",
        "tool": "chrome_screenshot",
        "args": {
          "name": "test_homepage",
          "storeBase64": true
        },
        "depends": ["start_test"]
      },
      {
        "id": "test_login",
        "tool": "chrome_workflow_execute",
        "args": {
          "workflow": {
            "name": "Login Flow Test",
            "steps": [
              {
                "id": "click_login",
                "tool": "chrome_click_element",
                "args": {
                  "selector": ".login-btn, #login, button:contains('Login')"
                },
                "waitFor": {
                  "type": "element_state",
                  "selector": "input[type='email'], input[name='username']",
                  "state": "visible",
                  "timeout": 5000
                }
              },
              {
                "id": "enter_username",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "input[type='email'], input[name='username']",
                  "value": "{{test_user.username}}"
                },
                "depends": ["click_login"]
              },
              {
                "id": "enter_password",
                "tool": "chrome_fill_or_select",
                "args": {
                  "selector": "input[type='password']",
                  "value": "{{test_user.password}}"
                },
                "depends": ["enter_username"]
              },
              {
                "id": "submit_login",
                "tool": "chrome_click_element",
                "args": {
                  "selector": "button[type='submit'], .login-submit"
                },
                "depends": ["enter_password"],
                "waitFor": {
                  "type": "navigation",
                  "timeout": 10000
                }
              }
            ]
          }
        },
        "depends": ["capture_homepage"]
      },
      {
        "id": "verify_login_success",
        "tool": "chrome_wait_for_condition",
        "args": {
          "condition": {
            "type": "element_state",
            "selector": ".user-menu, .profile, [data-testid='logged-in-indicator']",
            "state": "visible",
            "timeout": 10000
          }
        },
        "depends": ["test_login"]
      },
      {
        "id": "test_main_features",
        "tool": "chrome_get_interactive_elements",
        "args": {
          "includeCoordinates": true
        },
        "depends": ["verify_login_success"]
      },
      {
        "id": "test_navigation",
        "tool": "chrome_workflow_execute",
        "args": {
          "workflow": {
            "name": "Navigation Test",
            "steps": [
              {
                "id": "go_to_dashboard",
                "tool": "chrome_click_element",
                "args": {
                  "selector": ".dashboard-link, a:contains('Dashboard')"
                },
                "waitFor": {
                  "type": "navigation",
                  "url": "dashboard",
                  "timeout": 5000
                }
              },
              {
                "id": "verify_dashboard",
                "tool": "chrome_wait_for_condition",
                "args": {
                  "condition": {
                    "type": "element_state",
                    "selector": ".dashboard-content, [data-testid='dashboard']",
                    "state": "visible",
                    "timeout": 5000
                  }
                },
                "depends": ["go_to_dashboard"]
              },
              {
                "id": "capture_dashboard",
                "tool": "chrome_screenshot",
                "args": {
                  "name": "test_dashboard",
                  "storeBase64": true
                },
                "depends": ["verify_dashboard"]
              }
            ]
          }
        },
        "depends": ["test_main_features"]
      },
      {
        "id": "test_logout",
        "tool": "chrome_click_element",
        "args": {
          "selector": ".logout, .sign-out, button:contains('Logout')"
        },
        "depends": ["test_navigation"],
        "waitFor": {
          "type": "navigation",
          "timeout": 5000
        }
      },
      {
        "id": "verify_logout",
        "tool": "chrome_wait_for_condition",
        "args": {
          "condition": {
            "type": "element_state",
            "selector": ".login-btn, #login, button:contains('Login')",
            "state": "visible",
            "timeout": 5000
          }
        },
        "depends": ["test_logout"]
      },
      {
        "id": "generate_report",
        "tool": "chrome_screenshot",
        "args": {
          "name": "test_completion",
          "storeBase64": true
        },
        "depends": ["verify_logout"]
      }
    ]
  }
}
```

## Using Workflow Templates

### Save a Template
```json
{
  "name": "my_custom_template",
  "description": "Custom workflow for specific use case",
  "category": "custom",
  "tags": ["automation", "testing"],
  "workflow": {
    "name": "Custom Workflow",
    "steps": [
      // ... workflow steps
    ]
  }
}
```

### Load and Execute Template
```json
{
  "name": "ecommerce_product_purchase",
  "variables": {
    "product_url": "https://shop.mysite.com/product/456",
    "quantity": 1,
    "user_email": "customer@example.com"
  }
}
```

### List Available Templates
```json
{
  "category": "ecommerce"
}
```

## Workflow Monitoring

### Check Execution Status
```json
{
  "action": "status",
  "executionId": "workflow_1_1703123456789"
}
```

### List All Executions
```json
{
  "action": "list"
}
```

### Cancel Running Workflow
```json
{
  "action": "cancel",
  "executionId": "workflow_1_1703123456789"
}
```

### Clear Completed Executions
```json
{
  "action": "clear"
}
```

## Advanced Features

### Conditional Steps
```json
{
  "id": "conditional_step",
  "tool": "chrome_click_element",
  "args": {
    "selector": ".premium-feature"
  },
  "condition": "{{user_type}} === 'premium'",
  "depends": ["login"]
}
```

### Variable Updates During Execution
```json
{
  "id": "extract_data",
  "tool": "chrome_get_web_content",
  "args": {
    "selector": ".product-price",
    "storeAs": "current_price"
  }
}
```

### Nested Workflows
```json
{
  "id": "complex_checkout",
  "tool": "chrome_workflow_execute",
  "args": {
    "workflow": {
      "name": "Checkout Subworkflow",
      "steps": [
        // ... nested workflow steps
      ]
    }
  },
  "depends": ["add_to_cart"]
}
```

### Custom Wait Conditions
```json
{
  "id": "wait_for_processing",
  "tool": "chrome_wait_for_condition",
  "args": {
    "condition": {
      "type": "custom_js",
      "javascript": "document.querySelector('.loading-spinner').style.display === 'none'",
      "timeout": 30000,
      "interval": 1000
    }
  }
}
```

These examples demonstrate the power and flexibility of the workflow orchestration system for complex browser automation tasks. The system supports dependencies, error handling, retries, conditions, variables, and comprehensive monitoring.