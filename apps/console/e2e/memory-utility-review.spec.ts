import {test,expect} from '@playwright/test';
const bundle={contract:'memory-utility-review/v1',experiment_id:'utility-e2e',cases:Array.from({length:10},(_,i)=>({id:'c'+i,task:'次の実装方針を示す',answers:[1,2,3].map(j=>({id:'answer-'+j,text:'具体的な回答 '+j}))}))};
test('blind utility review protects old answers and persists explicit confirmation',async({page})=>{
 await page.goto('/admin/memory-extraction-evaluation');
 await page.evaluate(()=>localStorage.setItem('legacy-evaluation-answer','must-remain'));
 await page.locator('[data-utility-import]').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
 await expect(page.locator('[data-utility-reveal]')).toBeDisabled();
 await expect(page.locator('[data-utility-answers]')).toContainText('具体的な回答 1');
 await expect(page.locator('[data-utility-choice] option')).toHaveCount(7);
 await page.locator('[data-utility-choice]').selectOption('answer-1');
 await page.locator('[data-utility-confirm]').click();
 await expect(page.locator('[data-utility-status]')).toContainText('1 / 10');
 await expect(page.locator('[data-utility-choice]')).toBeDisabled();
 expect(await page.evaluate(()=>localStorage.getItem('legacy-evaluation-answer'))).toBe('must-remain');
 for(let i=1;i<10;i++){await page.locator('[data-utility-case]').selectOption('c'+i);await page.locator('[data-utility-choice]').selectOption('equal');await page.locator('[data-utility-confirm]').click();}
 await expect(page.locator('[data-utility-reveal]')).toBeEnabled();
 await page.reload();
 await page.locator('[data-utility-import]').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
 await expect(page.locator('[data-utility-status]')).toContainText('10 / 10');
 await expect(page.locator('[data-utility-confirm]')).toBeDisabled();
});
